# e01s02 — gRPC control and recovery

## 1. Purpose
Manage selected contexts and replicas through durable desired state instead of manual processes.

## 2. User story
As an operator, I enable billing, set three user replicas, and restore configuration after restart.

## 3. Status and complexity
Implemented, automated checks passing, user UAT pending. 8 BCP, P0 risk.

## 4. Dependencies
e01s01, stable readiness/HTTP semantics, and confirmed local state storage.

## 5. Inputs
Authorized SetContext with requestId and expectedRevision. Current desired/observed state.

## 6. Outputs
Durable operation ID, eventual status, ready workers, and a routing snapshot.

## 7. ADDED requirements
- Enable/disable/scale use one SetContext contract.
- Repeating requestId with the same payload does not create another operation.
- Persist desired state and operation before a successful response.
- Balance ready replicas. Drain covers the response body lifetime.
- Restart restores configuration without trusting old PIDs/ready flags.

## 8. Invariants
One controller writer. Context mutations are serialized.
Missing authorization and revision conflicts cause no mutations.

## 9. Control API
[runtime.md](../../design/runtime.md) — SetContext, GetOperation, GetStatus.
SetAutoscale currently returns UNIMPLEMENTED.

## 10. Storage
Local snapshot with schema version and atomic replacement. Truncated/corrupt snapshots are not empty state.
Restore active deployment and idempotency records together.

## 11. Separation rationale
The controller serializes decisions. The agent owns processes. The routing snapshot defines only the current serving set.

## 12. Errors
Status exposes unauthorized requests, conflicting revisions, invalid payloads, startup timeouts, exhausted restart budgets, and drain timeouts.

## 13. Security
Control binds only to loopback. Credential and scope checks precede mutations. Remote/TLS are rejected as unsupported for now.
Return safe client errors. Do not mix details and secrets in logs.

## 14. Compatibility
Verify lost reply + retry over actual gRPC transport, not only direct controller function calls.

## 15. Implementation steps
1. Add durable operations and state → verify: `test -f tests/e2e/control-state.test.ts && bun test tests/e2e/control-state.test.ts`.
2. Add ready balancing, drain, and worker recovery → verify: `test -f tests/e2e/worker-recovery.test.ts && bun test tests/e2e/worker-recovery.test.ts`.
3. Connect authenticated gRPC and CLI/status → verify: `test -f tests/e2e/control-lifecycle.test.ts && bun test tests/e2e/control-lifecycle.test.ts`.

## 16. Test data
Two contexts, a slow finite HTTP response, a crashing worker, interrupted state writes, and a lost reply after acceptance.

## 17. Acceptance criteria
- gRPC enables billing and sets exactly three desired user replicas.
- Repeating an accepted command creates no extra replicas/operations.
- A known disabled user returns 503. After startup, new requests use only ready workers.
- SIGTERM lets an active short request complete. The deadline forcibly stops a stuck request.
- Restart restores desired replicas. Corrupt state causes a diagnosable refusal.
- Unauthorized requests and mismatched expectedRevision do not mutate state.

## 18. Manual demonstration
Enable/scale contexts, kill one worker, and observe recovery and the restart budget.
Restart the main process under a supervisor. Verify status and saved configuration.

## 19. Out of scope
Release updates, multiple controllers, distributed consensus, and request migration after a crash.

## 20. Gate and handoff
e01s03 receives a verified local stop/recovery contract. All task verification commands pass. User UAT is not confirmed yet.
Evidence: [e01s02-verify.yaml](../../verifications/e01s02-verify.yaml). The full package and private-backend/PostgreSQL passed verification.
Structure check: `python3 scripts/check-specs.py`.
