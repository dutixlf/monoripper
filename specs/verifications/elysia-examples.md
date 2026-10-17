# Self-contained Elysia examples — 2026-10-17

Scope: replace the external application fixtures with repository-owned Elysia examples. Product runtime APIs and root dependencies are unchanged.

## Results

- `bun run typecheck`: passed.
- `bun test tests`: 49 passed, 0 failed, 208 assertions.
- `bun run test:elysia`: passed pagination defaults, query validation, conflict responses, separate worker PIDs and disabled-context isolation.
- `bun run test:elysia:postgres`: passed real PostgreSQL migration, health, authenticated CRUD, unauthorized mutations, duplicate 409, validation 422, cross-worker reads and soft deletion.
- The PostgreSQL check also passed gRPC 1→3 scaling, SIGKILL recovery, controller restart restoring three replicas, disable→503 and disabled-import isolation.
- `bun src/cli.ts check --app examples/elysia/app.ts`: passed.
- `bun run test:package`: passed archive installation, bundled worker and control checks.
- `bun run test:landing`: 11 disposable-repository scenarios passed. No project push occurred.
- `bun run check:specs` and `git diff --check`: passed.

Full command output: [elysia-examples.log](elysia-examples.log). The forced-drain negative test emits its expected connection error. It is not a failed test.

## Cleanup and boundaries

The checks stop workers and PostgreSQL and remove their temporary state. The database callback-failure regression verifies database directory removal and postmaster exit.

External fixture scripts, their workspace helper and their lockfile were removed. Historical external test records retain their original output under neutral filenames. They do not claim that the replacement examples ran on the historical dates.

A case-insensitive search of the working tree, including ignored files and installed dependencies, found no retired project-name references outside `.git`. Git remote configuration matched its pre-change snapshot exactly. Git history was not rewritten.

No new dependencies, production deployment, publication or container runtime changes are included. Container suites were not rerun for this fixture-only change. User UAT remains pending.
