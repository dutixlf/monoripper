# Impact: self-contained Elysia integration examples

## Target

Replace external application fixtures with repository-owned Elysia examples and remove project-specific references from scripts, documentation and historical evidence. Keep Git remote configuration unchanged.

## Dependents

- `package.json`: integration commands become `test:elysia` and `test:elysia:postgres`.
- `scripts/`: remove external checkout/workspace installation and use local examples.
- `examples/elysia/`: demonstrate validation, errors, SQL resources and full/sliced apps.
- README, e01s01 tasks, state and verification records: update runnable commands; anonymize historical external evidence without relabeling it as a new test run.
- Remove the retired external fixture lockfile. Keep root dependencies and `bun.lock` unchanged.

## Affected stories

- e01s01: Elysia behavior and shared PostgreSQL CRUD across replicas.
- e01s02: PostgreSQL-backed scale, worker recovery, restore and disable checks.
- e01s03: historical integration evidence only; container behavior is unchanged.

## Test coverage

Existing compatibility, HTTP, resource and control E2E tests remain unchanged. Replacement integration checks must cover validation/auth errors, real database writes/reads across PIDs, soft deletion, disabled imports, recovery and persisted replica counts. Run typecheck, native tests, both new integration commands, package smoke and specs checks.

## Risk: Medium

The removed harness has no product runtime callers. The main risk is losing integration coverage or presenting historical evidence as a new Elysia run. Preserve scenarios and label historical records explicitly. No new dependencies or runtime API changes are needed.

## Recommended action

Proceed with local fixtures, verify both commands and confirm the remote configuration is byte-for-byte unchanged.
