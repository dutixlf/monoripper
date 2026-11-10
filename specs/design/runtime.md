# Execution, gRPC, and clustering

Status: target design and pseudocode. Purpose: define explicit lifecycle and control behavior.
Local workers/gateway, protobuf gRPC, and desired-state recovery are implemented. Clustering and autoscaling are not. See the [actual API](../../README.md).
Basis: [architecture](../tech-architecture/tech-stack.md), [application API](application-api.md).

## 1. Lifecycle worker

`created → starting → ready → draining → stopped`. Startup errors lead to `failed`.
Declare ready only after resources, context.create, deferred modules, listen, and the internal readiness probe complete.
Each worker has `workerId`, `context`, `release`, `generation`, `nodeId`, and a random local startup token.
The agent verifies IPC message ownership against a process it actually created. A workerId in a message is not sufficient.

```ts
async function spawnWorker(spec) {
  const child = Bun.spawn([bunExecutable, runnerPath, '--spec', spec.privateFile], {
    env: buildRestrictedEnv(spec),
    cwd: spec.releaseDir,
    ipc(message, sender) { handleWorkerMessage(spec, sender, message) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // Continuously consume and bound stdout/stderr logs. Otherwise a full pipe can block the process.
  observeExit(child, () => removeFromReadyAndReport(spec.workerId))
  const ready = await waitForAuthenticatedReady(child, spec.startupTimeoutMs)
  await probeLocalApp(ready.address, spec.startupTimeoutMs)
  return ready
}
```

This is a Bun IPC sketch. A smoke test must verify the exact signature instead of copying it without checks.
On timeout, terminate the process and exclude it from the routing table.
Crash recovery uses backoff, a finite restart budget, and a visible error after budget exhaustion.

## 2. HTTP gateway

```ts
async function forward(request) {
  const snapshot = routing.current() // Immutable snapshot for selection.
  const owner = snapshot.findOwner(request.method, validatedPath(request.url))
  if (!owner) return safeError(404, 'NOT_FOUND')
  const worker = selectReadyRoundRobin(snapshot.workersFor(owner))
  if (!worker) return safeError(503, 'CONTEXT_UNAVAILABLE')

  const metadata = createRequestMetadata(request) // Untrusted internal headers are removed.
  const lease = acquireRequestLease(worker) // The counter lasts until the response body ends.
  try {
    const response = await transport.forward(worker, request, {
      metadata,
      signal: combineClientAbortAndDeadline(request, metadata.deadline),
      preservePathAndQuery: true,
    })
    return wrapResponseLifetime(response, lease) // Success, abort, and stream errors release the lease.
  } catch (error) {
    lease.releaseOnce()
    return mapTransportError(error) // unavailable 503, upstream error 502, timeout 504
  }
}
```

Do not call Elysia handlers directly or pass request bodies through JSON IPC.
Do not buffer complete uploads/responses. Set body, header, and time limits.
Preserve status, required headers, and separate Set-Cookie values. Remove hop-by-hop headers.
Client abort cancels the upstream request. Decrement in-flight only after the body ends, not after receiving headers.
An upstream failure does not prove that an operation did not execute.
WebSocket upgrades follow the same ownership/header rules and are relayed per [e01s04](../epics/e01-local-runtime/e01s04-websocket.md). Other upgrades return 501.
SSE and other streaming responses pass through unbuffered but stay bounded by the request deadline; endless streams are not guaranteed.

## 3. Drain

```ts
async function drain(worker, deadline) {
  routing.remove(worker.id) // Stop new assignments.
  await agent.beginDrain(worker.id) // Reject new local arrivals, including assignment races.
  const finished = await waitForInflightZero(worker, deadline)
  if (!finished) record('DRAIN_TIMEOUT', worker.id)
  await agent.shutdown(worker.id, { forceAfterDeadline: deadline })
}
```

On shutdown, the worker first stops accepting new requests. Then it calls context.stop and closes resources.
SIGTERM stops ingress/control acceptance, finishes workers within the grace period, and waits for exit.
The runtime must collect child process statuses. Containers do not need privileged mode.
The external container stop grace period must exceed the internal drain + cleanup timeout.

## 4. gRPC contract

The following protobuf-like service sketch is provisional. Message definitions follow during implementation.
All control requests include project, environment, and authorization.

```protobuf
service Control {
  rpc SetContext(SetContextRequest) returns (Operation);
  rpc GetOperation(GetOperationRequest) returns (Operation);
  rpc GetStatus(GetStatusRequest) returns (Status);
  rpc SetAutoscale(SetAutoscaleRequest) returns (Operation);
}
// SetContextRequest:
// request_id, project, environment, context,
// expected_revision, optional release_digest, optional replicas
// replicas = 0 disables the context. An absent field leaves the value unchanged.
// CLI Deploy/Scale/Disable are convenience wrappers over SetContext.
```

`SetAutoscale` is available after e03s03. Before that, return UNIMPLEMENTED, not false success.
A watch stream is optional. The first CLI can poll GetOperation until a terminal state within an overall timeout.
Client wait expiration does not cancel a persisted operation. The CLI prints operationId for later inspection.

```ts
async function setContext(input, caller) {
  authorize(caller, input.project, input.environment, 'deploy-or-scale')
  validateInput(input)
  return state.serialized(async () => {
    const old = state.findByRequestId(input.requestId)
    if (old) {
      assertSamePayload(old.payloadHash, input) // Otherwise return ALREADY_EXISTS.
      return old
    }
    assertExpectedRevision(input.expectedRevision)
    assertContextKnownAndReleaseAllowed(input)
    const next = applyPatchAndCreateOperation(state.snapshot(), input)
    await persistAtomically(next) // One snapshot contains desired state, operation, and idempotency.
    state.replace(next)
    scheduleReconcile(input.context)
    return next.operation
  })
}
```

Serialize mutations per context. Revision changes return CONFLICT/ABORTED instead of silently overwriting state.
The same requestId and payload return the same operation, including after restart.
Document the idempotency retention window. Retries beyond that window require a new requestId and a status check.
Reject mutations while a context operation is unfinished, or explicitly supersede it with a generation check. Rejection is simpler for the prototype.

## 5. Persistence and recovery

Desired state and the operation are durable before command acknowledgement.
On restart, the controller acquires an exclusive state lock, validates the snapshot, and observes processes again.
In single-node mode, the main process must control/remove leftover children before startup. A snapshot PID does not prove process ownership.
The prototype uses a supervisor that terminates the entire process group/cgroup. Without that guarantee, diagnose bare-process restart rather than promising no orphans.

For an unfinished deployment, restore the operation with target and last-good references. Do not combine its continuation with a new request.
The new target version receives traffic only after another readiness check.
If the target is not ready, restore last-good and fail the operation with a reason.
Restart can cause temporary unavailability. Persistent state does not preserve live HTTP connections.

## 6. Request metadata

Allowed fields are traceId, requestId, deadline, and explicitly configured identity/tenant claims.
Do not forward arbitrary headers as trusted authorization.
The gateway removes external internal headers. After credential validation, it creates an internal envelope.
Workers accept envelopes only over authenticated agent/gateway transport.
Identity claims follow actual authentication. A traceId is not a credential.

SDK `services.fetch` propagates the current request envelope and validates the target context and path ownership.
Without request scope, the SDK creates a new trace and requires a separate service identity for privileged calls.
The deadline is an upper bound subject to policy limits and clock-skew tolerance. Measure local timeouts with a monotonic clock.
The request path is not sufficient evidence of authorization.

## 7. Multiple nodes

The first extension retains one controller/gateway. Each additional node runs `monoripper node`.
The agent establishes an authenticated control connection and reports capacity and heartbeats.
For HTTP, the controller uses an agent HTTPS endpoint on the private network. Worker ports are not public.
The agent validates assigned workerId/generation and proxies only to its own loopback workers.
Locally, the gateway uses the same transport contract over a short loopback path.

```ts
function placement(context, candidates) {
  return candidates
    .filter(node => node.healthy && node.runtimeCompatible(context.release))
    .filter(node => node.hasAvailableSlot(context.resourceEstimate))
    .sort(byFewestAssignedReplicasThenNodeId)[0]
}
```

No cloud APIs. Without a suitable node, keep the operation pending or fail at timeout with `INSUFFICIENT_CAPACITY`. Do not spawn indefinitely.
Resource estimates are admission policy, not hard memory isolation.
Startup commands and assignments include generation. An outdated agent cannot overwrite newer configuration after reconnect.
Heartbeat loss removes the old node from traffic. Recreating workers elsewhere does not prove that old processes are dead.
Therefore, exactly-once jobs and strict singleton services are not promised.

## 8. Bounded autoscaling

Disabled by default. Enablement requires min, max, and targetInFlight.
The first metric is a window of measured HTTP in-flight load per context, not automatic diagnosis of slow requests.
This is a heuristic. Database waits can increase in-flight load without improving when more processes start.

```ts
function desiredReplicaCount(policy, metrics, capacity) {
  if (!metrics.fresh || metrics.windowTooShort) return 'unchanged'
  if (!cooldownExpired() || contextHasActiveOperation()) return 'unchanged'
  const estimate = Math.ceil(metrics.averageInFlight / policy.targetInFlight)
  const target = clamp(estimate, policy.min, policy.max)
  const admitted = Math.min(target, capacity.admissibleReplicas)
  return applyHysteresisAndStepLimit(admitted) // Scale-down needs a longer quiet window.
}
```

The autoscaler uses the same versioned SetContext, not a separate spawn mechanism.
Manual scaling is rejected by default while autoscaling is active. Disable the policy first so it cannot reverse the operator decision.
Do not combine rollout and scaling in one unfinished operation.
Cooldown, windows, and step limits are configurable and verified with deterministic fake-clock tests.

## 9. Initial prototype observability

JSON logs: timestamp, severity, project, environment, context, release, workerId, nodeId, operationId, traceId, code.
Status: desired/ready replicas, serving/target release, operation phase, last failure, node health.
Metrics include in-flight, requests/errors, latency, restart count, and queue/start/drain durations.
Do not require Prometheus/OTel infrastructure for first startup. Add export separately.
Main gateway readiness and individual context readiness are different statuses.

Document check: `python3 scripts/check-specs.py`.
Future process and fault-injection checks are in the [roadmap](../ROADMAP.md).
