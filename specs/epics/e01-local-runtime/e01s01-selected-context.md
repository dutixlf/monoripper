# e01s01 — HTTP from a selected context

## 1. Purpose
Deliver the first end-to-end path: declaration → separate Elysia worker → gateway → client.

## 2. User story
As a developer, I start user without executing billing and receive normal Elysia behavior through a stable port.

## 3. Status and complexity
Implemented, automated checks passing, awaiting user UAT. 8 BCP, P0 risk.

## 4. Dependencies
Agreed API, installed pinned Bun, and available verified Elysia/gRPC versions.

## 5. Inputs
Source manifest with entries, ownership, and resource declarations. Selected user context.

## 6. Outputs
User HTTP Response or an explicit error. Disabled billing produces no import side effects.

## 7. ADDED requirements
- One owner per method/path. Collisions prevent startup.
- One Bun process per replica. Load only selected entries.
- Create resources before ready and close them after startup failure.
- The linter prohibits direct and shared-mediated imports of other contexts.
- Elysia middleware and schemas execute in workers. The gateway does not bypass them.
- ADDED follow-up: verify the real backend and tags context on shared temporary embedded PostgreSQL 18 without database/business mocks.

## 8. Invariants
Ready only after startup completes. Shared code does not imply shared memory.
The gateway does not execute extracted handlers.

## 9. Application API
[application-api.md](../../design/application-api.md) defines the target contract.
Implemented API and limitations: [README](../../../README.md). Bun 1.3.13, Elysia 1.4.30.

## 10. Processes and files
Implemented definitions, check, worker including the Elysia adapter, ownership/http, runtime, and config/CLI.
No general plugin framework was created.

## 11. Separation rationale
The adapter isolates Elysia details from process management. The checker detects architectural violations before startup.

## 12. Errors
503 for a known disabled context, 404 for an unknown path. Operators can inspect startup/import errors.

## 13. Security
Loopback workers, ownership checks, removal of untrusted internal headers, and HTTP size/time limits.

## 14. Compatibility
Verify the gRPC client/server on Bun and real Elysia hooks/listen/stop on the pinned version.
The presence of node:http2 alone is insufficient evidence.

## 15. Implementation steps
1. Configure the package/toolchain and compatibility checks → verify: `test -f tests/compat/grpc-bun.test.ts && test -f tests/compat/elysia.test.ts && bun test tests/compat`.
2. Implement the selected worker and resources → verify: `test -f tests/e2e/selected-context.test.ts && bun test tests/e2e/selected-context.test.ts`.
3. Add the import checker → verify: `test -f tests/unit/import-boundaries.test.ts && bun test tests/unit/import-boundaries.test.ts`.
4. Verify gateway and ownership → verify: `test -f tests/e2e/http-semantics.test.ts && bun test tests/e2e/http-semantics.test.ts`.
5. Verify real private-backend with PostgreSQL → verify: `test -f scripts/test-private-backend-postgres.ts && bun run test:private-backend:postgres "$BACKEND_BACKEND_DIR" "$BACKEND_PACKAGES_DIR"`.
Supply external source checkout paths explicitly. See the project README for preparation.

## 16. Test data
user uses login/register/users. billing uses an import-side-effect sentinel fixture. db uses a counted start/stop fixture.
A real resolver must check aliases and barrel re-export fixtures.

## 17. Acceptance criteria
- The user response includes middleware/validation results, not only handler output.
- The billing sentinel did not execute and its resource was not created.
- Duplicate ownership, cross-context imports, and startup rejection produce diagnosable errors.
- POST body, query, params, status, and multiple Set-Cookie values pass through correctly.
- gRPC metadata, deadlines, errors, and shutdown pass on the selected Bun version.
- Real migrations, authorization, CRUD, and soft deletion pass on PostgreSQL. Different worker PIDs serve writes and reads.

## 18. Manual demonstration
Start the user example and call user. Calling known billing returns 503. An unknown path returns 404.
Add a forbidden import and show `check` output with file/line/rule.

## 19. Out of scope
Persisted control state, remote nodes, registry, hot deployment, and autoscaling.
Do not initialize every context implicitly to obtain routing metadata.

## 20. Gate and handoff
After checks pass, detail the stabilized API and proceed to e01s02.
All five task verification commands passed. Initial slice evidence: [e01s01-verify.yaml](../../verifications/e01s01-verify.yaml).
PostgreSQL follow-up: [embedded-postgres-verify.yaml](../../verifications/embedded-postgres-verify.yaml).
User manual verification is not confirmed yet. Structure check: `python3 scripts/check-specs.py`.
