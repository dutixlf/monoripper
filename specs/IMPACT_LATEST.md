# Impact: WebSocket relay (e01s04)

## Target

Relay WebSocket upgrades from the public gateway to context replicas, so a context can serve plain Elysia `.ws()` routes. Verify SSE passthrough.

## Dependents

- `src/runtime.ts`: upgrade routing, handshake, limits, 1001 on shutdown; graceful `stop(false)` is no longer awaited (Bun 1.3.13 never settles it after an upgrade).
- `src/websocket.ts` (new): RFC 6455 client to the replica and the relay.
- `src/worker-pool.ts`, `src/process-worker.ts`: per-replica socket sets; drain closes them and waits.
- `src/worker.ts`: `.ws()` routes own as GET; WebSocket limits passed to Elysia `listen`.
- `src/config.ts`, `src/definitions.ts`: `http.websocket`. `src/metrics.ts`: `monoripper_websocket_*`.
- README, examples/websocket, specs scope/design/state.

## Affected stories

- e01s01: upgrade requests no longer always return 501; HTTP behaviour is unchanged.
- e01s02: drain also waits for relayed sockets within `shutdownTimeoutMs`.

## Test coverage

New `tests/e2e/websocket.test.ts` and config unit test. Existing HTTP, control, recovery and container tests unchanged and passing.

## Risk: Medium

Hand-written framing on the replica side and Bun quirks (drain re-entry, pause slack, graceful stop). Mitigated by e2e flood, size, close-code and lifecycle tests.
