# e01s04 — WebSocket relay

## 1. Purpose
Let a context serve live updates over WebSocket through the public gateway, with the same ownership, header and lifecycle rules as HTTP.

## 2. User story
As an application developer, I declare a GET route in `owns`, write plain Elysia `.ws()` in the context, and clients connect on the public port.

## 3. Status and complexity
Implemented, automated checks passing, user UAT pending. 5 BCP, P1 risk from long-lived connections, framing and drain.

## 4. Dependencies
e01s01 gateway and ownership, e01s02 drain and recovery. Bun 1.3.13 `Bun.serve` WebSockets and `Bun.connect`, Elysia 1.4.30 `.ws()`.

## 5. Inputs
Client upgrade request, `http.websocket` limits, `lifecycle` timeouts, trusted proxies and the ready replica set.

## 6. Outputs
A relayed socket per client, the replica's status for refused handshakes, close codes on lifecycle events, and `monoripper_websocket_*` metrics.

## 7. ADDED requirements
- WebSocket upgrades match ownership as GET and pick a ready replica round-robin.
- The gateway opens the replica socket first; a refused handshake returns the replica status without upgrading.
- Path, query, subprotocol, cookies, authorization and end-to-end headers are forwarded; internal, hop-by-hop and untrusted forwarding headers are not.
- Text, binary, close codes and reasons pass both ways with backpressure and a message size limit.
- Drain and shutdown close sockets with 1001 within `shutdownTimeoutMs`; replica exit closes them with 1012.
- Non-WebSocket upgrades return 501, unowned paths 404, limits 503.

## 8. Invariants
`maxRequestBodyBytes` applies to HTTP only. Metric labels contain context and a fixed close reason, never paths, clients or identities. No access logs.

## 9. Startup interface
`http.websocket: { maxMessageBytes = 1 MiB, maxConnections = 1024, idleTimeoutSeconds = 120 }`. The worker passes message and idle limits to Elysia `listen`.

## 10. Storage
None. Sockets are not persisted and do not survive a replica or runtime restart.

## 11. Separation rationale
Bun's WebSocket client hides refused handshake statuses, so the relay speaks RFC 6455 over `Bun.connect` to the replica. The client side stays on `Bun.serve`.

## 12. Errors
400 `INVALID_UPGRADE`, 501 `UPGRADE_NOT_SUPPORTED`, 503 `WEBSOCKET_LIMIT`/`CONTEXT_UNAVAILABLE`, 502 `UPSTREAM_ERROR`, 504 `DEADLINE_EXCEEDED`.
Socket closes: 1009 oversize, 1011 invalid replica frame, 1012 replica lost, 1013 relay backpressure overflow.

## 13. Security
The internal credential and client address header are set by the gateway; clients cannot supply them. The client's key and extensions are not forwarded.
Business authentication stays in the context (`beforeHandle`/`upgrade`).

## 14. Compatibility
Bun 1.3.13 graceful `server.stop()` never settles after a WebSocket upgrade; the runtime relies on the forced stop.
Bun's client reports a received 1001 as 1000; tests read raw close frames. Without a selected subprotocol, Bun picks the first offered one.

## 15. Implementation steps
1. Relay, gateway integration, worker `.ws()` support and limits → verify: `bun test tests/e2e/websocket.test.ts`.
2. Config validation → verify: `bun test tests/unit/config.test.ts`.

## 16. Test data
`tests/fixtures/local/live.ts` echo/info/private routes, an SSE route and `examples/websocket`.

## 17. Acceptance criteria
- Echo, binary, subprotocol, header forwarding/stripping, upstream reject, unowned 404 and 501 pass end to end.
- Replica exit closes with 1012 and recovery serves new sockets; scale-down and shutdown close with 1001 in time.
- Metrics show open sockets and close reasons without paths or clients. SSE arrives unbuffered.

## 18. Manual demonstration
Run `examples/websocket`, subscribe, POST a notification, then stop the runtime and observe close code 1001.

## 19. Out of scope
Cross-replica fan-out, permessage-deflate, WebSocket over HTTP/2, endless HTTP streams beyond `requestTimeoutMs`.

## 20. Gate and handoff
Both task entrypoints and the full suite pass. Evidence: [e01s04-verify.yaml](../../verifications/e01s04-verify.yaml). User UAT pending.
