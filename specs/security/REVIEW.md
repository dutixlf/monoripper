# Self-review: e01s02 local control

Scope: diff from 6100bad plus new control/state/worker modules, on branch feat/local-control.
Purpose: check trust boundaries before a green checkpoint. No independent reviewer ran.

## Reviewed flows

- HTTP → fixed loopback worker. The runtime chooses host/protocol/port, does not follow redirects, and removes private/hop headers.
- gRPC → auth → scope → validation → serialized snapshot. Validate credentials before mutation. Every method is scoped to project/environment.
- Credential → metadata. The printable ASCII guard prevents grpc-js from including an invalid secret value in metadata errors.
- SetContext → worker spawn. Only known contexts and bounded integer counts are allowed, without user-controlled shells or executable paths.
- Snapshot → restore. Strict schema, duplicate ID/pending-operation guards, no persisted PID/ready truth. Corrupt state is not replaced with initial.
- State file → native lock. Constant libc flock signature, controller-owned FD, O_NOFOLLOW, private temporary writes, fsync/rename/fsync.
- Process exit → recovery. Remove workers from the ready set before restart. Enforce a finite budget and expose exhaustion.
- Scale-down → stream lease → cleanup. Read the body before stop. Timeouts kill the process. Failed disable cleanup does not re-enable the context.

## Findings and fixes

1. Single-worker drain errors lost SHUTDOWN_TIMEOUT inside AggregateError.
   Regression: worker-recovery.test.ts first failed, then passed with the exact operation error code.
2. The uint32 protocol could round invalid SDK replica counts before server validation.
   The client validates integer/range before protobuf encoding. Fractional requests are rejected.
3. A SIGKILLed parent cannot enforce a child cleanup deadline.
   The worker has its own bounded disconnect timeout. Crash/replay tests verify that the old PID disappears.
4. CLI retries without the original expectedRevision could change the request payload.
   The CLI prints requestId and the original revision before sending. The README requires both on retries.
5. URL-based authority validation lost explicit port 80 and accepted query suffixes.
   Replaced with exact loopback host:port grammar. Regression checks port 80 and rejects query suffixes.

## Pre-main recheck — 2026-10-16

Scope: the entire local-control diff from 6100bad and current regression fixes before fast-forward to main.

- Rechecked gateway headers/worker URLs, gRPC auth/scope, state schema/lock, spawn, and drain.
- BUG-001: replayed failed growth restores both desired state and actual previous replicas.
  Failure to restore the previous count still aborts cold startup.
- BUG-002: invalid Connection tokens no longer throw during header forwarding.
  The request lease starts only after URL/headers/deadline preparation. Invalid HTTP leaves no phantom inFlight count.
- No new dependencies, shell commands, auth bypasses, or broader network exposure.
- The full regression suite, installed-package smoke, and real private-backend/PostgreSQL checks passed again.
- This is another self-review, not an independent audit. Evidence: [pre-main verify](../verifications/pre-main-verify.yaml).

## Landing workflow review — 2026-10-16

User explicitly approved installing the protected-branch landing workflow.
Reviewed `scripts/land-branch.sh` and its disposable-repository tests: quoted/validated branch inputs,
fixed destination `main`, matching origin URLs, ancestry and clean-tree checks, mandatory verification,
verified commit pinning, non-force atomic push, and final remote SHA check.
The guard exception is scoped to the landing script after checks; global hooks are unchanged.
Eleven regression scenarios pass, including divergence, verification failure, unexpected push URL,
and atomic rejection. No new runtime dependencies, secrets or application network endpoints.
Evidence: [landing workflow](../verifications/landing-workflow.md). Self-review only.

## Verdict

Self-review found no unresolved concrete HIGH/CRITICAL findings.
This is not security certification or a claim of production readiness.

## Boundaries and intentional limitations

- Local admin token, not multi-tenant IAM. Remote plaintext is prohibited. TLS/RBAC are not presented as implemented.
- Config and application code are trusted executables, not a sandbox. Same-UID malicious code is not isolated by kernel namespaces.
- The PostgreSQL fixture is test tooling only. Migrations are developer-authored. Public input does not reach runtime library SQL.unsafe.
- Cold startup remains fail-fast. A broken persisted context requires dependency/state repair before control bind.
- Native locking targets Linux/glibc and local filesystems. Distributed/NFS lock correctness is not promised.
- Shutdown timeout bounds processes/bodies. fsync on stalled kernel storage has no hard real-time cancellation.
- Elysia event hooks target verified 1.4.30. Version upgrades require compatibility tests.
- e01s02 has no release provenance/registry. Registry security remains a separate stage.

Evidence: [verify record](../verifications/e01s02-verify.yaml).
Checks: `bun run typecheck`, `bun test tests`, `bun run test:package`, `bun run test:private-backend:postgres <backend> <packages>`.
