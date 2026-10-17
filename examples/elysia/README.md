# Elysia integration examples

From the repository root:

```sh
bun run test:elysia
bun run test:elysia:postgres
```

The first command runs `pagination.ts` in two workers. It checks query defaults, validation, errors, different worker PIDs and a disabled context.

The PostgreSQL command creates a private temporary PostgreSQL 18 database and applies `migration.sql`. It runs `full.ts` in two workers, then runs `app.ts` with only the tags context selected. Both use the same `routes.ts` Elysia plugin and database resource.

Checks include authenticated CRUD, unauthorized writes, duplicate slugs, validation, cross-worker reads, soft deletion, gRPC scaling, worker recovery, restart restoration and disable-to-503. The reports context stays unloaded. Workers close their connection pools before the test database is stopped and removed.

Requires installed project dependencies and a non-root user for PostgreSQL. No external source checkout, additional installation, production database or provider credentials are used. Generated credentials and controller state live only for the test. These are test examples, not a production authentication or database migration system.
