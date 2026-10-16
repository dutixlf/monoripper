# Impact: embedded PostgreSQL and the real private-backend backend

Purpose: extend e01s01 from shared-module checks to real HTTP → Elysia → Drizzle → PostgreSQL integration.

## Target

New test-only fixtures/harness, the `embedded-postgres` dev dependency, npm scripts, and verification documentation.
The Monoripper production runtime and default configuration do not include an embedded database.

## Dependents

- `package.json` / `bun.lock`: dev installation and verification commands.
- Existing `test:private-backend` remains a fast independent smoke test without a database.
- The new harness uses `monoripper.serve` without changing its public contract.
- External backend: use a clean temporary source copy and real workspace packages. Original checkouts remain unchanged.

## Affected Stories

An e01s01 extension for integration evidence. It does not implement e01s02 control/state or replace the business database with runtime state.

## Test Coverage

The existing 27 tests protect the runtime. Add a real PostgreSQL fixture lifecycle test and a separate backend database integration command.
Required path: real migrations → health → unauthorized write → authorized CRUD → reads through another replica → soft deletion.
Also load the full backend `src/app.ts`, without database/router mocks. Do not call external OAuth providers.

## Risk: Medium

The native PostgreSQL binary on NixOS and missing workspace dependencies require compatibility checks.
No new production API is planned. Generate credentials only for the temporary loopback database.

## Prior Art

- [OK] adopt `embedded-postgres` 18.4.0-beta.17 (MIT, test-only): `initialise()`, `start()`, `stop()`, `getPgClient()`.
  Source: https://github.com/leinelissen/embedded-postgres. API verified against documentation. Inspect source after installation.
- Real backend migrations require PostgreSQL 18 and its `uuidv7()`, without a local replacement function.
- Use existing backend routers, Drizzle schema, and SQL migrations without mocks.
- The root local-development checkout is outdated and lacks current package workspaces. Build an isolated test workspace from real package repositories.

## Plan

1. Pin the dev dependency and verify the native lifecycle on a temporary cluster with `bun test tests/compat/embedded-postgres.test.ts`.
2. Prepare real backend/workspace dependencies outside the original checkout. Do not run third-party install scripts.
3. Add a database harness over Monoripper with `bun run test:private-backend:postgres <backend> <packages-directory>`.
4. Verify cross-replica CRUD/shared database access, the complete app, process termination, and removal of private temporary directories only.
5. Repeat typecheck, normal tests, and npm package smoke. Record actual results and limitations.

Document check: `python3 scripts/check-specs.py`.
