# Impact: e01s03 container lifecycle

## Target

Add a pinned Linux/glibc image, container example, and real rootless Podman tests.
Keep the existing loopback control API. User-approved container administration uses engine exec.
Packaging does not change the application deployment protocol. A reproduced PID-1 startup bug also
requires CLI signal handling and an optional programmatic-only startupSignal in ServeOptions (BUG-003).

## Dependents

- `package.json` / `bun.lock`: frozen image installations and new opt-in container test commands.
- `src/cli.ts`, runtime, worker pool, controller and state store: exercised as built code, not mocked.
- `examples/container/`: new application fixture imports the package API, not source modules.
- README, e01s03 spec/tasks, roadmap and state: document exec-based control and actual evidence.
- Existing package consumers, local examples and PostgreSQL harness must continue to work unchanged.

## Affected stories

- e01s03 owns the image, secret/state mounts, network boundaries, shutdown and recreation tests.
- e01s01/e01s02 retain their public interfaces and 45-test regression baseline.
- Remote TLS control remains deferred. Registry/releases and multiple nodes remain e02/e03 work.

## Test coverage and gaps

Existing tests cover local auth, snapshots, crash replay, worker recovery and response-body drain.
They do not prove container PID-1 signals, network namespaces, filesystem permissions or cgroup limits.
Add opt-in real-container boundary and lifecycle suites. Missing engines must fail with setup guidance,
not report a skipped suite as passing. Use an isolated image, secret, volume and containers per run.
Do not touch user containers or run global prune commands.

## Risk: High

The CLI/runtime/worker startup path is shared by local consumers, examples and integration harnesses.
Container namespaces and volume ownership also require real tests.
First verify non-root startup, persistence and exec control, then add lifecycle and failure scenarios.
BUG-003 first reproduced exit 137 during gated startup. Native and container regressions now cover
cancellation, cleanup failure and writer reacquisition. No new npm dependency is required.

## Prior art

- https://bun.com/guides/ecosystem/docker — multistage builds and explicit non-root runtime user.
- https://docs.podman.io/en/latest/markdown/podman-run.1.html — keep-id mapping, read-only mounts and secrets.
- https://docs.podman.io/en/latest/markdown/podman-exec.1.html — administration in the existing container.
- Verified `oven/bun:1.3.13-debian` amd64 manifest digest:
  `sha256:550178b0d9fefc73c8758eb1ee9bb7eff90747ba1008d80a5bb76695b3fd9265`.

## Execution plan

1. Build the image and prove non-root HTTP startup plus authenticated exec control on a fresh volume.
2. Verify private worker/control listeners, read-only root, secret handling and bounded resources.
3. Exercise scale, worker crash recovery, finite request drain, bounded SIGTERM and persistent recreation.
4. Verify explicit startup failures and absence of orphan processes or test-owned resource leaks.
5. Re-run local/package/landing/PostgreSQL regressions, self-review and record actual evidence.

User approved this plan and exec-based control. Commit only green checkpoints. No push, publication,
production deployment or NixOS system configuration change is authorized by this implementation step.
