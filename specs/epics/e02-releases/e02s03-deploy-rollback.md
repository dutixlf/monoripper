# e02s03 — Deploy, rollback and CI/CD

## 1. Purpose
Move selected contexts to a published digest without interrupting ingress, and roll back by deploying a retained digest.

## 2. User story
As a CI job, I run `monoripper deploy --release release.json --contexts api --wait` for staging, then the same file for production.

## 3. Status and complexity
Implemented, automated checks passing, user UAT pending. 8 BCP, P0 risk from the switch and crash recovery.

## 4. Dependencies
e01s02 operations and drain, e02s01 cache, e02s02 registry.

## 5. Inputs
`SetContext` with `release` (digest) and optional `replicas`; CLI `deploy`, `operation --id --wait`, `status`; control over TLS for CI runners.

## 6. Outputs
One operation per context with `step` progress (`preparing`, `starting`, `switching`, `draining`), `release`, optional `warning`; status shows `release`, `servingRelease`, `lastGoodRelease`.

## 7. ADDED requirements
- Candidates of the target release start and pass readiness while the old replicas serve.
- Routing ownership and replicas switch in one synchronous step after the new ownership is checked against all other serving contexts.
- Old replicas drain: in-flight requests finish on the old release; new requests reach the new one.
- Failures before the switch stop candidates and restore the previous release and count (`failed`).
- A crash after the switch replays the durable operation from the target digest; failure then restores the previous release.
- Old and new replicas need capacity at the same time; otherwise `CAPACITY_EXCEEDED` and nothing changes.
- A release can add a context; a missing one fails with `RELEASE_CONTEXT_MISSING`. Source-mode runtimes reject digests (`RELEASES_DISABLED`).

## 8. Invariants
Deploy requests carry only digests, never URLs. Deployment idempotency keys are the request's intent, so CI retries with the same `--request-id` return the original operation.

## 9. Startup interface
Runtime config `release`, `registry`, `capacity.maxReplicas`, `control.tls`. CLI `deploy --release --contexts [--replicas] [--request-id] [--wait]`.

## 10. Storage
State schema 2: `releases`, `serving`, `lastGood` per context; version 1 state migrates on open.

## 11. Separation rationale
The first algorithm prepares the full new serving set and switches once; incremental surge is deferred.

## 12. Errors
`CAPACITY_EXCEEDED`, `OWNERSHIP_CONFLICT`, `RELEASE_CONTEXT_MISSING`, `RELEASES_DISABLED`, `CONTEXT_START_FAILED`, `REGISTRY_UNAVAILABLE`, `DIGEST_MISMATCH`.

## 13. Security
CI and runtime use separate registry credentials; deployment uses the control credential. Control without TLS stays loopback-only.

## 14. Compatibility
Group deployments are separate operations; partial success is reported per context with a nonzero exit.

## 15. Implementation steps
1. Deploy, switch, rollback, partial CLI rollout → verify: `bun test tests/e2e/deploy.test.ts`.
2. Pipeline gate staging → production → same entrypoint.

## 16. Test data
Five releases from `versionedApp`: v2 good, v3 with broken billing, v4 with conflicting ownership, v5 adding a context.

## 17. Acceptance criteria
- A slow v1 request finishes with v1 bytes while new requests already reach v2; the operation reports `draining` then `succeeded`.
- Broken v3 billing fails before its switch while api moves to v3; billing keeps v1; the CLI exits 1 and retries return the same operations.
- Rollback to v1, ownership conflict, new context and missing context behave as specified; desired releases survive restart.
- Capacity for old + new is enforced. A SIGKILL right after the switch (`MONORIPPER_FAILPOINT=deploy-after-switch`) replays to success.
- One digest from CLI pack/publish deploys to staging and production; waiting resumes by operation ID; a runtime bootstraps from `release.json`.

## 18. Manual demonstration
[examples/releases](../../../examples/releases/README.md) and the [CI example](../../../examples/releases/ci.yml).

## 19. Out of scope
Incremental surge, automatic error-rate rollback, database migrations, atomic multi-context deployment.

## 20. Gate and handoff
All entrypoints pass. Evidence: [e02-verify.yaml](../../verifications/e02-verify.yaml). User UAT pending.
