# Impact: e01s02 local control

Purpose: add replica control, recovery, and durable desired state without changing context source code.
Base: 6100bad, branch feat/local-control. The user authorized implementation and commits of verified checkpoints only.

## Target / callers

- runtime/worker: CLI, examples, E2E, and the private-backend harness depend on these. Preserve serve/status/stop compatibility.
- config/definitions: add optional environment, dataDir, recovery, and loopback control configuration.
- New state-store, worker-pool, controller, and gRPC modules separate storage, process ownership, and transport.
- Package metadata/build: grpc-js + proto-loader become runtime dependencies. Deliver control.proto in dist.

## Contracts

- Without control/dataDir, existing serve calls remain ephemeral and initial behaves as before.
- With persistence, initial applies only to the first snapshot. User configuration is not rewritten.
- Accepted mutations are durable. requestId replay creates no new operation. Revisions prevent lost updates.
- Failed workers receive no new requests. Restart budgets are finite. Scale-down waits for response bodies.
- The first control transport supports only loopback with credentials from env. Remote plaintext is prohibited.
- Release deployment and autoscaling are not implemented under the scale API.

## Risk: High

Shared runtime/config APIs and a new durable boundary. Regression, crash/restart, auth, and real gRPC tests are mandatory.

## Decisions / Prior Art

- [OK] Existing grpc-js 1.14.6 and proto-loader 0.8.1 provide a real protobuf contract, not JSON disguised as protobuf.
- [OK] Native Linux flock through Bun FFI passed checks for exclusive ownership across two file descriptors and release after close.
  Kernel locks avoid stale PID locks and release after crashes. Do not remove the lock inode.
- Atomic snapshot uses private temp file → fsync → rename → directory fsync. Do not replace invalid snapshots with defaults.
- Global serialized state and lifecycle queues are sufficient for the prototype. Separate roles do not hold a mutex during worker startup.
- 10000 retained operations is an explicit finite limit without silent idempotency record eviction.
- Git identity comes from authenticated GitLab @dutix and was set globally at user request.

## Steps / verification

1. Native locked atomic state store + strict validation → `bun test tests/unit/state-store.test.ts`.
2. Worker pool with lease lifetime/drain/recovery and controller operations → `bun test tests/e2e/control-state.test.ts tests/e2e/worker-recovery.test.ts`.
3. Protobuf gRPC auth/status/SetContext + CLI → `bun test tests/e2e/control-lifecycle.test.ts`.
4. Crash/replay, private-backend PostgreSQL integration, installed-package smoke, and self-review. Only then create a stable commit.

Document check: `python3 scripts/check-specs.py`.
