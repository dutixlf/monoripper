# Implementation roadmap

Status: e01s01/e01s02/e01s03 automated checks passed, awaiting UAT. e02/e03 are not implemented yet.
Purpose: deliver verifiable value through vertical slices.
The full product includes e01–e03. Exclusion from e01 does not cancel a requirement.

## Execution rules

- Base architecture agreed. The user authorized implementation.
- Bun 1.3.13 is available through Nix. package.json, source, and e01s01 tests already exist.
- e01s01 commands passed. See [initial verification](verifications/e01s01-verify.yaml) and [PostgreSQL follow-up](verifications/embedded-postgres-verify.yaml).
- Other verify commands are future checks, not completed tests.
- Test commands use `test -f ... && bun test ...`. Missing files cannot produce a false PASS.
- e01 has detailed story specs and all task checks pass. User UAT remains pending. e02/e03 remain a roadmap.
- Create files/packages only as needed. Do not build speculative layers without an end-to-end scenario.
- Pin libraries and versions after verification. Do not publish npm packages or deploy without a separate request.

## e01. One container, managed contexts

### e01s01 — first HTTP response from a selected context

Demo: start `user`. Serve `/api/login` from a separate process without importing `billing`.

1. Prepare the package, pinned Bun toolchain, tests, lint/check, and a two-context example.
2. Verify gRPC client/server on Bun, including metadata, deadlines, errors, and channel closure.
3. Implement declarations, a lazy worker runner, an ownership gateway, and an import checker.
4. Verify hooks, cookies, dynamic routes within prefixes, and startup errors.
5. Follow-up completed: real private-backend app and separate tags context on embedded PostgreSQL, with real migrations/CRUD across different PIDs.

Verify: `test -f tests/e2e/selected-context.test.ts && bun test tests/e2e/selected-context.test.ts`.
Also run `test -f tests/compat/grpc-bun.test.ts && bun test tests/compat/grpc-bun.test.ts`.

### e01s02 — control and recovery

Demo: enable billing over gRPC, set three user replicas, disable user, and restart the runtime with saved configuration.

1. Implement versioned SetContext, authorization, durable operations, and idempotency.
2. Balance only ready workers, track response body lifetime, and drain before shutdown.
3. Restore desired state, limit restarts, and return errors to the operator.

Verify: `test -f tests/e2e/control-lifecycle.test.ts && bun test tests/e2e/control-lifecycle.test.ts`.
Required fault cases: lost gRPC response after acceptance, worker crash, truncated state, and shutdown with an active request.

### e01s03 — the same scenario in a container

Demo: one non-root container, loopback control through authenticated engine exec, a persistent volume, and correct SIGTERM handling.
User-approved scope: [ADR 0001](adr/0001-container-exec-control.md). Remote network control/TLS is deferred.

1. Build a minimal image with pinned Bun and runtime, without a Docker socket or privileged mode.
2. Repeat the lifecycle outside the container. Verify recovery after recreation with a volume.
3. Verify that stop leaves no orphan workers and bound the restart policy.

Verify: `test -f tests/container/lifecycle.sh && bash tests/container/lifecycle.sh`.

e01 gate: all three stories pass, typecheck/tests pass, and errors remain visible. Detail e02 only after this gate.

## e02. Registry and implementation changes without ingress interruption

### e02s01 — package a portable release

Demo: package the application. Run its entry from the archive without the source checkout or dependency installation.
Verify shared chunks, assets, the manifest, pinned compatibility, and absence of secrets.
Verify: `test -f tests/e2e/release-pack.test.ts && bun test tests/e2e/release-pack.test.ts`.

### e02s02 — publish/download through the private registry

Demo: CI credentials publish a digest. Runtime credentials retrieve the same archive. Repeated publication is safe.
Verify auth, digest mismatch, traversal, links, oversized archives, interrupted downloads, and full disks.
Verify: `test -f tests/e2e/registry.test.ts && bun test tests/e2e/registry.test.ts`.

### e02s03 — deploy, rollback, pipeline

Demo: an old slow request finishes on v1. New requests use v2 after the switch. Broken v3 does not displace v2.
The CLI supports `pack`, `publish`, `deploy --wait`, status, and resumed waits by operationId.
Prepare one example CI pipeline. The main contract does not depend on a specific CI provider.
Verify partial success across contexts, temporary old+new capacity, and crashes between switch and persistence.
Verify: `test -f tests/e2e/deploy.test.ts && bun test tests/e2e/deploy.test.ts`.

e02 gate: one digest moves from staging to production without rebuild. Failed startup preserves the old serving version.

## e03. Multiple nodes and bounded autoscaling

### e03s01 — remote replica and request context

Demo: the gateway on node A serves a request through the agent/worker on node B. Internal calls preserve trace/deadline and permitted identity claims.
Verify TLS/auth, unreachable advertised addresses, worker port privacy, and attempts to forge internal headers.
Verify: `test -f tests/e2e/two-nodes.test.ts && bun test tests/e2e/two-nodes.test.ts`.

### e03s02 — node placement and recovery

Demo: the controller assigns contexts only to compatible healthy nodes. Reconnection does not apply an outdated generation.
Verify heartbeat loss, registry outages, insufficient capacity, and controller restart.
Demonstrate singleton job limitations during partitions explicitly. Do not describe failover as exactly-once execution.
Verify: `test -f tests/e2e/node-recovery.test.ts && bun test tests/e2e/node-recovery.test.ts`.

### e03s03 — autoscaling with limits

Demo: synthetic load increases replicas within max. A quiet window reduces replicas to min.
Verify stale metrics, cooldown, hysteresis, exhausted capacity, and conflicts with manual scaling/deployment.
Verify: `test -f tests/e2e/autoscale.test.ts && bun test tests/e2e/autoscale.test.ts`.

e03 gate: fake-clock tests are deterministic. Real load measurements cannot be replaced with a polished demonstration.

## Exclusions from this roadmap

- Controller/ingress HA and seamless container replacement.
- Automatic server procurement/provisioning.
- Database migration rollback, heap snapshots, and exactly-once jobs.
- Arbitrary dynamic imports/native addons without release format verification.
- WebSocket/SSE before a separate connection specification.

## Plan verification

`python3 scripts/check-specs.py` checks document structure and local links, not future runtime behavior.
A real parser checks YAML separately. Protocols and the bundler require future executable tests.
Next action: UAT of e01, including the container example, then detailed e02 registry/release work. Control remains local-only, not remote TLS/HA.
