# Monoripper

Run selected Elysia contexts in separate Bun processes through one HTTP gateway.

**Status: initial local prototype, not production-ready. The package is unpublished.**
Selective startup, initial replicas, resource lifecycles, import checks, and local configuration are implemented.
gRPC control, persistent desired state, a registry, release updates, and clustering are not implemented yet.

## Requirements

Verified environment: Linux, Bun **1.3.13**, Elysia **1.4.30**.
For NixOS, run `nix shell nixpkgs#bun`. The working toolchain version is in `.bun-version` and `package.json`.
Install project dependencies with Bun, not npm.

## Quick start from this repository

```sh
bun install --frozen-lockfile
bun src/cli.ts check --app examples/local/app.ts
bun src/cli.ts serve --config examples/local/monoripper.config.ts
```

Open `http://127.0.0.1:3000/api/user/status`.
The response contains `context: user` and the PID of a separate process.
`/api/billing/status` returns 503 because the context is known but not running.
SIGINT/SIGTERM stops the gateway, contexts, and resources.

## Application API

In an installed local package, import from `monoripper`. The repository example uses paths to `src`.

```ts
import { defineApp, defineContext, monoripper } from 'monoripper'

// monoripper.app.ts contains declarations only, without imports of context modules.
export const app = defineApp({
  project: 'shop',
  contexts: {
    user: {
      entry: './contexts/user.ts',
      owns: [{ method: '*', path: '/api/user/*' }],
    },
  },
})

// contexts/user.ts is a separate file with a default export.
export default defineContext({
  create: ({ app }) => app.get('/api/user/status', () => ({ pid: process.pid })),
})

// CLI alternative: import app from the manifest and start the runtime programmatically.
const runtime = await monoripper.serve({
  app,
  root: import.meta.dir, // Manifest directory, not the context module directory.
  initial: { user: { replicas: 1 } },
  http: { host: '127.0.0.1', port: 3000 },
})
// ...
await runtime.stop()
```

The three snippets belong to separate files. The complete runnable example is in `examples/local/`.
The context factory returns the supplied `app`. Use `app.use(plugin)` for existing Elysia routers.
Do not call `.listen()` inside a context. The adapter awaits async `onStart`/`onStop` hooks and closes resources in reverse order.
The worker cleans up after startup failure, a stop signal, or loss of its parent IPC connection.

## Local configuration

```ts
import { defineConfig } from 'monoripper'

export default defineConfig({
  app: './monoripper.app.ts',
  initial: { user: { replicas: 2 } },
  http: { host: '127.0.0.1', port: 3000, maxRequestBodyBytes: 1048576 },
  lifecycle: { startupTimeoutMs: 15000, shutdownTimeoutMs: 10000, requestTimeoutMs: 30000 },
})
```

- Select the file explicitly with `serve --config <file>`. Each installation can have its own file.
- Priority: defaults → selected config → explicit `--host`/`--port` options.
- `app` resolves relative to the config. Entries and resources resolve relative to the application manifest.
- `http`, `lifecycle`, and `env` merge by field. `initial` is replaced as a whole.
- Supply secrets through the environment or a local config file excluded from the release.
- Config is trusted executable TypeScript/JavaScript, not a sandbox. Configuration discovery and hot reload are not supported.
- Unknown options are rejected. In particular, `control`, `dataDir`, and `registry` are not supported yet, rather than silently ignored.

## Routes and resources

Each method/path has one owner. `owns` supports exact paths and a trailing `/*`.
The `/api/user/*` prefix includes `/api/user` and its descendants, but not `/api/user-old`.
Cover HEAD/OPTIONS explicitly or use method `*`. Context ownership cannot overlap.
An unknown path returns 404. A known context without a live replica returns 503.

For a resource, declare its entry and allowed contexts in `app.resources`. Then list its name in `context.resources`.
A resource module exports `defineResource({ start, stop })` as its default.
`start({env, context})` returns the resource. `stop(value)` releases it.
The factory provides `resources.get<T>(name)`. Each replica creates its own resource instance, not one instance per cluster.
For a lifecycle example, see `tests/fixtures/local/resource.ts`.

## Boundary checks

`check --app <manifest>` analyzes imports, re-exports, tsconfig aliases, require calls, and literal dynamic imports without executing contexts.
Shared modules do not import contexts. Contexts do not import each other.
For context directories, the entry directory defines the boundary. When entry files share a directory, the default boundary is the entry itself.
For explicit boundaries, set `context.root` and keep each context implementation in a separate directory.
Computed dynamic imports are rejected. External npm dependencies are not analyzed as application code.
The check is not a sandbox or a replacement for typecheck. Programmatic `serve` does not run it automatically. Include `check` in CI.

## HTTP and errors

Elysia middleware, validation, status, query, cookies, redirects, and compressed bytes are preserved.
The gateway does not follow redirects or retry requests after upstream errors.
External clients cannot supply internal headers or hop-by-hop headers.
Workers listen on loopback and also require a random internal credential.
Failures before response headers return a safe 502/504. After the body starts, a timeout aborts the stream without changing the sent status.

Unhandled exceptions return a safe 500. Application error handlers are preserved.
For detailed errors, supply an `onDiagnostic(event)` callback to programmatic `serve`.
This callback is for operators. Application messages can contain sensitive data. Filter them before storage.

## Checks and build

```sh
bun run typecheck
bun test tests
bun run build
bun dist/cli.js --help
bun run test:package
python3 scripts/check-specs.py
```

Tests start real child processes, HTTP, a gRPC client/server, and temporary PostgreSQL 18.
The PostgreSQL compatibility test requires a non-root user. The native postinstall for `@embedded-postgres/linux-x64` is explicitly allowed in package.json.
Other platforms are unverified. They can require permission for the corresponding native package.
The gRPC compatibility test does not mean that the control API is implemented.
After build, create a local npm archive with `bun pm pack --ignore-scripts --destination /tmp/monoripper-package`.
This command publishes nothing. The product license is undecided. `UNLICENSED` is intentional.

## External backend and embedded PostgreSQL

```sh
git clone --depth 1 <private-repository> /tmp/private-backend-backend
mkdir -p /tmp/private-backend-packages
for p in <private-packages>; do
  git clone --depth 1 "<private-repository>" "/tmp/private-backend-packages/$p"
done
bun run test:private-backend:postgres /tmp/private-backend-backend /tmp/private-backend-packages
```

This harness:

1. Copies committed HEAD snapshots of the backend and real workspace packages to a separate temporary directory.
2. Starts `embedded-postgres` 18 on a random loopback port with a new database and generated test credentials.
3. Applies unchanged `migration.sql` files sequentially to the new database without calling the production migrator.
4. Runs the complete `src/app.ts` through Monoripper in two processes, with health, CORS, OpenAPI, and real authenticated tags CRUD.
5. Verifies writes through one replica and reads through another using real PIDs, duplicate 409, validation 422, and soft deletion.
6. Repeats CRUD with a separate tags context. The reports context is disabled and its bootstrap is not loaded.
7. Stops workers and PostgreSQL, then removes its temporary directories, including after test failure.

**One test PostgreSQL server serves all replicas.** Each worker creates a client/pool, not its own database server.
`embedded-postgres` is a dev dependency, not part of the Monoripper production runtime. `test:package` verifies its absence from the npm consumer.
The fixture does not use an external `DATABASE_URL` or an existing data directory.
Original checkouts, uncommitted changes, `.env`, and production services remain unchanged. OAuth and external provider calls are not tested.

Disposable package.json files omit only devDependencies and scripts. Production dependencies and backend source remain real.
Reason: an upstream package tooling references unavailable `gql-tada`. Bun resolves workspace dev dependencies even with `--production`.
The test workspace uses pinned lockfile `integration/private-backend-runtime.bun.lock`. Normal runs use frozen installation without install scripts.
If upstream dependencies change, update the lockfile explicitly with `BACKEND_UPDATE_LOCKFILE=1 bun run test:private-backend:postgres <backend> <packages>`.
Git is used only for external test snapshots, not the product deployment protocol.

The database-free smoke test remains available. `bun run test:private-backend /tmp/private-backend-backend` checks real shared pagination/error modules only.
Upstream AGPL code remains external test input and is not included in the published Monoripper package.

## Limitations and next step

Worker restart, dynamic scaling, configuration restoration after restart, WebSocket/SSE, and cross-node calls are not implemented.
The HTTP port does not provide authentication. Elysia contexts must implement business auth. Public services also need a standard TLS ingress.
Replicas share container limits. Exactly-once guarantees and isolation of untrusted code are not provided.
Next step: gRPC control and durable desired state (`e01s02`).
Design and roadmap: [specs/README.md](specs/README.md).
