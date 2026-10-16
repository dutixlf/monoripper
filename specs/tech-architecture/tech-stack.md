# Monoripper architecture

Status: target design. Local HTTP slice e01s01 is implemented. Other roles follow the roadmap.
Actual API and limitations: [project README](../../README.md). Purpose: define component boundaries and invariants.
Basis: [scope](../product/SCOPE_LATEST.yaml), [decisions for agreement](../README.md).

## 1. Product and boundaries

One npm package provides the SDK, CLI, gateway, controller, node agent, worker runner, and registry.
These are product roles, not mandatory separate installations or services.

- `serve`: gateway + controller + local agent. Starts selected worker processes.
- `node`: an agent on another node. Connects to the controller and starts workers.
- `registry`: HTTP release storage. Can run as a separate process of the same package.
- `pack`, `publish`, `deploy`, `scale`, `status`: client commands.

The prototype gateway and controller share one main process. Their independent availability is not promised.
A new worker must import only its selected context entry and permitted resource entries, not the entire application.

## 2. Terms

| Term | Meaning |
| --- | --- |
| Context | Logical application part with routes and a lifecycle |
| Replica | One Bun process executing one context |
| Node | Agent and resources of one machine/container |
| Release | Immutable application archive addressed by digest |
| Deployment | Request to bring one context to a release and replica count |
| Ownership | Rules assigning HTTP methods and paths to a context |
| Request context | Permitted request metadata, not an Elysia Context object |
| Desired state | Persisted configuration the runtime aims to provide |
| Observed state | Current processes, health, and errors |

Each object belongs to a `project` and `environment`. Identical context names such as `user` do not merge separate projects.

## 3. Principles

1. **Explicit boundaries.** Each route has one owner. Shared means library code, not a shared process.
2. **No hidden RPC.** Cross-context calls explicitly use the SDK with a deadline.
3. **Process isolation.** One event loop and heap per replica. No sandbox or separate cgroup guarantee.
4. **Immutable releases.** Do not replace running code on disk. A new release creates a new process.
5. **Desired state.** Use `replicas: 3` instead of a non-idempotent add-one command.
6. **Readiness before traffic.** Successful spawn or an open port does not establish application readiness.
7. **Visible errors.** Do not suppress failed imports, startup, resource cleanup, or deployments.
8. **Data outside the runtime.** Databases, queues, and user files do not live in the release directory.
9. **Simple topology first.** One controller and one ingress, without custom consensus.
10. **Bounds.** Archive sizes, process counts, startup time, drain time, and restart retries are finite.

## 4. Component responsibilities

| Component | Responsibility | Reason for separation |
| --- | --- | --- |
| SDK / Elysia adapter | Context declarations and complete Elysia app construction | Keep framework-specific behavior out of the runtime |
| Gateway | Ownership, ready-replica selection, HTTP forwarding | Stable public address as processes change |
| Controller | Desired state, operations, placement, revisions | One mutation owner instead of command races |
| Agent | Spawn, readiness, heartbeat, drain, exit | One process mechanism locally and on remote nodes |
| Worker runner | Load one entry, resources, app, shutdown | Do not execute disabled contexts |
| Registry | Authorized reads/writes of immutable blobs | Separate code delivery from process control |
| Import checker | Module ownership checks | Detect direct coupling before startup |

Do not create a general plugin platform, DI container, service mesh, or separate internal message bus.
Use Bun IPC for local process management, HTTP for HTTP requests, and gRPC for commands/state.

## 5. Minimal state model

```ts
// Pseudocode, not a commitment to final TypeScript types.
type ContextDesired = {
  release: Digest
  replicas: number
  generation: number
  autoscale?: { min: number; max: number; targetInFlight: number }
}
type ContextObserved = {
  servingRelease?: Digest
  lastGoodRelease?: Digest
  workers: WorkerStatus[]
  lastError?: { code: string; operationId?: string }
}
type Operation = {
  id: string
  requestId: string
  payloadHash: string
  context: string
  generation: number
  phase: 'accepted' | 'preparing' | 'starting' | 'switching'
       | 'draining' | 'succeeded' | 'failed' | 'superseded'
  error?: { code: string; message: string }
}
```

Persist: desired state, revision, last-good release refs, operation/idempotency records.
Do not persist PID, ready flags, or active request counts as truth. Observe them again after restart.
A persisted ready flag does not make a recovered process alive.

The first store uses one local state snapshot, a single writer, a process lock, and atomic replacement.
Persist snapshots through temp-file → fsync(file) → rename → fsync(directory) on a supported local filesystem.
Validate the schema version. Never silently replace invalid or unknown formats with empty configuration.
Do not share a state volume between two active controllers.

## 6. Ownership and versions

The gateway does not extract Elysia handlers. It selects the context. The worker executes complete routing/middleware.
The application declares ownership explicitly. Controller startup does not execute context modules.
A context can temporarily have workers from two releases during update preparation. The active table selects its serving set.

Rules:

- Unknown ownership → 404.
- Known ownership without ready replicas → 503.
- The worker selected a context but Elysia found no internal route → normal application 404.
- Ownership collision across contexts → reject configuration before switching traffic.
- Active context route changes must be checked against ownership in all other active releases.
- A new release configuration does not update unselected contexts automatically.

A runtime implementation change does not imply public API compatibility.
The application owns API compatibility and expand/contract database migrations.

## 7. Failures and limitations

| Event | Behavior |
| --- | --- |
| Worker dies | Remove from ready set, report the error, and restart within a finite budget |
| New version fails startup | Do not switch traffic. Keep the old serving version |
| Controller/gateway fails | Ingress is unavailable in this topology until the main process recovers |
| Registry unavailable | Running and fully cached releases continue to operate |
| Agent loses controller | Accept no mutations. Keep the last assigned set until reconnect |
| Remote heartbeat expires | Exclude the node from new routing. Its processes can remain alive |
| Drain expires | Terminate the process and record aborted requests. Do not promise successful completion |
| Container OOM | All contexts can be lost. Per-context memory isolation is not guaranteed |

A network partition does not guarantee a single background job executor.
Do not automatically retry arbitrary POST requests. Process restart cannot safely repeat a business operation.
The prototype does not coordinate cron/jobs. Application code must explicitly decide whether each replica can run them.

## 8. Security without a custom IAM platform

- Local worker ports are not public.
- Control gRPC listens on loopback by default. Remote control requires TLS and scoped credentials.
- Authenticate node-to-node transport. A `nodeId` or forwarded header alone does not establish trust.
- Authorize registry uploads/downloads separately from deployment. Verify digests after download. A digest does not replace authorization.
- Limit archive size/file count. Reject traversal, symlinks, and device files.
- Supply secrets on the node. CI excludes them from releases and `release.json`.
- Validate identifiers, paths, and manifest schemas at trust boundaries.
- Operators can inspect detailed errors. Do not expose stack traces, paths, or secrets publicly.

## 9. Technology and technical checks

| Choice | Assessment | Verification before implementation |
| --- | --- | --- |
| Bun with built-in spawn/build/test/fetch | [OK] selected runtime | Pin the version and verify real processes/builds |
| Elysia | [OK] user-selected | Pin the major version and verify hooks, plugins, and shutdown |
| `@grpc/grpc-js` | [OK] candidate | Verify actual client/server on Bun, including metadata, deadlines, errors, and shutdown |
| TypeScript compiler API | [OK] import checker candidate | Verify path aliases, re-exports, and dynamic imports |
| Tar implementation | Undecided | Compare Bun built-ins with a small library. Safe extraction is mandatory |
| Storage | Files + JSON snapshot | Verify atomic replacement and recovery after interrupted writes |
| `embedded-postgres` 18.4.0-beta.17 | [OK] user-selected for tests | PG 18.4, real migrations/CRUD for the full app and tags context verified on Linux x64. Not a production state store |

For e01s01, package.json and bun.lock pin Bun 1.3.13, Elysia 1.4.30, grpc-js 1.14.6 for compatibility tests, and TS 5.9.3.
Tar handling and the release format are not implemented yet. The Monoripper license is undecided, with UNLICENSED specified.
Context7 was unavailable in the tool catalog. Official documentation through web search provided API verification.

Technical references:

- [Elysia routing](https://elysiajs.com/essential/route): `app.handle(Request)` passes through the application, not only an individual handler.
- [Elysia plugins](https://elysiajs.com/essential/plugin): `.use()` and `app.modules` do not provide process isolation.
- [Bun build](https://bun.sh/docs/bundler): `entrypoints`, `target: 'bun'`, `splitting`. Deliver shared chunks together.
- [Bun spawn](https://bun.sh/docs/api/spawn): parent `ipc`/`child.send`, child `process.on('message')`/`process.send`.
- [Bun compatibility](https://bun.sh/docs/runtime/nodejs-compat): HTTP/2 API availability does not remove the need for gRPC smoke tests on the selected version.

Link and required invariant checks: `python3 scripts/check-specs.py`.
