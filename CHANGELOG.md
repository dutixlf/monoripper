# Changelog

## 0.1.0-prototype (unreleased, unpublished)

First prototype of the full release plan (e01–e03). All APIs are provisional. Automated checks pass; user acceptance is pending.

### Local runtime (e01)

- Selected Elysia contexts in separate Bun processes behind one HTTP gateway, with explicit route ownership and an import boundary checker.
- Replicas, resources, background contexts, worker recovery with a restart budget, and drain of response bodies.
- Protobuf gRPC control (status, scale, operations) with idempotent request IDs and durable desired state.
- Health, readiness and Prometheus metrics, trusted-proxy client addresses and JSON logs.
- Rootless, non-root container example with exec-based control.
- WebSocket relay with backpressure, buffer caps, keepalive and lifecycle close codes (Autobahn conformant, compression excluded).

### Releases (e02)

- `monoripper pack`: deterministic, location-independent release archives with shared chunks, bundled dependencies and assets;
  Elysia and the SDK are shared with the runtime; boundary violations, unresolved imports and native addons are refused.
- `monoripper registry` and `publish`: content-addressed storage with separate read/write credentials, digest and archive validation,
  safe repeats, size limits and `507` on storage exhaustion.
- Release-mode runtime (`release` instead of `app`): verified read-only cache, offline start from cache, bootstrap for new state only.
- `monoripper deploy`: per-context switch to a digest with candidates ready first, atomic routing switch, drain on the old release,
  rollback by digest, crash replay, capacity for old + new replicas, ownership checks, idempotent CI retries.
- Optional TLS for the control API (`control.tls`, CLI `--ca-file`), so CI can deploy over a private network.
- Example GitHub Actions pipeline that moves one digest from staging to production.

### Cluster (e03)

- `monoripper node`: node agents that run assigned replicas and proxy gateway HTTP and WebSockets over verified TLS with a cluster credential.
- Placement on the node with the fewest replicas among compatible healthy nodes with capacity; heartbeat loss, partition reconnect,
  agent restart and controller restart are reconciled so outdated replicas stop.
- Request envelope (trace id, request id, remaining deadline), `requestContext(request)`, and `services.fetch` for explicit
  cross-context calls with caller identity and allowlisted claims, also across nodes.
- Bounded autoscaling per context (`SetAutoscale`, CLI `autoscale`) on gateway in-flight load with windows, hysteresis, cooldown,
  step limits and capacity admission; manual scaling is rejected while a policy is active.

### Compatibility notes

- State files move to schema 2 on first open. Earlier builds cannot read them.
- `SetAutoscale` now takes a context and policy and returns the policy; it previously returned `UNIMPLEMENTED` only.
- Source-mode types are unchanged; release mode adds `ReleaseRuntimeConfig`, `ReleaseServeOptions` and `loadRuntimeConfig`.
- The license is still undecided (`UNLICENSED`).
