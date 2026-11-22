# e03s01 — Remote replica and request context

## 1. Purpose
Serve a context replica on another machine through the one gateway and carry request metadata across contexts and nodes.

## 2. User story
As an operator, I start `monoripper node` on a second machine; replicas placed there serve public traffic, and contexts call each other with `services.fetch`.

## 3. Status and complexity
Implemented, automated checks passing, user UAT pending. 8 BCP, P0 risk from credentials, TLS and header forgery.

## 4. Dependencies
e02 release cache and registry (remote nodes run releases only), e01 gateway and relay.

## 5. Inputs
Controller `cluster` (TLS listener, CA, credential), node config (`id`, `controller`, `listen`, `advertise`, `registry`, `capacity`), `services.claims`.

## 6. Outputs
Remote replicas in status with `node`; request envelope headers; `requestContext(request)` and `services.fetch` in contexts.

## 7. ADDED requirements
- The gateway reaches remote replicas only through the agent's HTTPS endpoint with the cluster credential; the agent proxies HTTP and WebSockets to its loopback workers.
- The gateway adds a trace id (from a valid `traceparent` or new), a request id and the remaining deadline; clients cannot supply any `x-monoripper-*` header.
- `services.fetch(path, { request, claims })` routes by ownership with the caller's trace and remaining deadline, the caller context and only allowed claims; agents relay calls to the controller.
- Agents refuse requests without the cluster credential; the controller verifies agent certificates against its CA.

## 8. Invariants
Workers listen on loopback only. Worker, services and cluster credentials never reach application environments.

## 9. Startup interface
Controller: `cluster: { host, port, tls, caFile, tokenEnv, heartbeatTimeoutMs }`. Node: `monoripper node --config`. Context: `create({ services })`, `requestContext(request)`.

## 10. Storage
No new durable state; node membership is observed from heartbeats.

## 11. Separation rationale
The agent reuses the worker runner and relay; the gateway keeps one transport contract with an endpoint per replica.

## 12. Errors
`NODE_UNREACHABLE` for unreachable or untrusted agents, 401 `UNAUTHENTICATED` for missing credentials, `SERVICES_UNAVAILABLE` outside a context.

## 13. Security
One shared cluster credential authenticates both directions, see [ADR 0003](../../adr/0003-cluster-trust.md). A compromised node compromises the cluster.

## 14. Compatibility
Nodes must report the release's exact runtime compatibility to receive its replicas.

## 15. Implementation steps
1. Envelope and services.fetch → verify: `bun test tests/e2e/request-context.test.ts`.
2. Node agent, remote placement, cross-node services and WebSockets, TLS and credentials → verify: `bun test tests/e2e/two-nodes.test.ts`.

## 16. Test data
`tests/fixtures/services`, `clusterApp` releases, the test CA in `tests/fixtures/tls` with a trusted and an untrusted certificate.

## 17. Acceptance criteria
- A replica on node-b is a child of the agent and serves through the gateway; services calls from it reach billing with trace, caller and allowed claims.
- WebSockets relay through gateway and agent. Forged envelope headers have no effect.
- Agents and the cluster endpoint reject missing or wrong credentials and unknown CAs; untrusted and unreachable agents receive no replicas.

## 18. Manual demonstration
[examples/cluster](../../../examples/cluster/README.md).

## 19. Out of scope
Remote control by agents, per-node credentials, mTLS identities, cross-replica WebSocket fan-out.

## 20. Gate and handoff
All entrypoints pass. Evidence: [e03-verify.yaml](../../verifications/e03-verify.yaml). User UAT pending.
