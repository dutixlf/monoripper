# Application API: Elysia, contexts, and shared modules

Status: target API and pseudocode. Purpose: show changes in the user application.
For the implemented subset, see the [project README](../../README.md). `services.fetch`, control, and persisted state are not implemented yet.
Related documents: [architecture](../tech-architecture/tech-stack.md), [runtime](runtime.md).

## 1. Application structure

```text
monoripper.app.ts          # Declarations only, without database connections.
src/
  contexts/
    user.ts
    billing.ts
  shared/
    database.ts           # Resource factory.
    password.ts           # Ordinary library function.
    contracts.ts          # DTOs/schemas for explicit interactions.
```

A context does not import another context. Shared code does not import contexts.
Ordinary shared functions do not need a special wrapper. Resources with a lifecycle need one.

## 2. Application manifest and serve

```ts
import { defineApp, monoripper } from 'monoripper'

export const app = defineApp({
  project: 'shop',
  contexts: {
    user: {
      entry: './src/contexts/user.ts',
      owns: [
        { method: 'POST', path: '/api/login' },
        { method: 'POST', path: '/api/register' },
        { method: 'GET', path: '/api/users/*' },
      ],
      resources: ['db'],
    },
    billing: {
      entry: './src/contexts/billing.ts',
      owns: [{ method: '*', path: '/api/billing/*' }],
      resources: ['db'],
    },
  },
  resources: {
    db: {
      entry: './src/shared/database.ts',
      contexts: ['user', 'billing'],
    },
  },
})

// A separate bootstrap entry imports only the declarative app.
await monoripper.serve({
  app,
  environment: 'production',
  initial: { user: { replicas: 1 } }, // billing is known but disabled.
  http: { host: '0.0.0.0', port: 3000 },
  control: { host: '127.0.0.1', port: 50051 },
  dataDir: '/var/lib/monoripper',
})
```

In a real project, declarations and bootstrap belong in separate files so `pack` can read declarations without starting a server.
The manifest does not import `user.ts`, `billing.ts`, or `database.ts`. Entries are strings.
When persisted state exists, `initial` does not overwrite it. Changes go through the control API.

For local development, `serve` accepts a source manifest. In production, CLI `serve --release <digest>` reads the packaged release manifest.
The manifest knows disabled context ownership in advance. The gateway can return 503 without executing that context.

## 3. Ownership: an explicit prototype limitation

Support only exact paths and prefixes with a trailing `/*`, plus a specific method or `*`.
`/api/users/*` includes `/api/users` and its slash-separated descendants, but not `/api/users-old`.
The query string is excluded. Paths are case-sensitive. The gateway does not decode encoded slashes or rewrite paths.
Ambiguous/invalid encoded paths are rejected. Adapter tests verify consistent normalization.

- Rules from different contexts cannot overlap for overlapping methods.
- Do not add a most-specific-context priority. An error is safer than a hidden ownership change.
- `*` overlaps all methods. Cover HEAD and OPTIONS explicitly or with `*`.
- Elysia parameters (`:id`) remain inside the worker. The gateway matches a prefix.
- Authentication, validation, CORS, and business middleware remain in the Elysia context and survive proxying.
- Worker health endpoints use a separate internal channel, not an application route.

`owns` does not duplicate handlers, but repeats some path information. This is an intentional prototype trade-off for lazy startup.
Ownership generation can follow later. Packaging must not require startup of all contexts and databases.
The adapter checks started application routes against ownership, including implicit HEAD/OPTIONS.
Version-dependent route metadata access stays in the adapter and e01s01 tests. If unreliable, use explicit compile-time declarations, not middleware bypasses.

## 4. Elysia context

```ts
// src/contexts/user.ts
import { defineContext } from 'monoripper'
import { hashPassword } from '../shared/password'

export default defineContext({
  async create({ app, resources, services }) {
    // app is an Elysia instance with adapter hooks installed BEFORE route registration.
    const db = resources.get('db')

    return app
      .post('/api/register', async ({ body }) => {
        // A complete example needs a body schema and safe error handling.
        const passwordHash = await hashPassword(body.password)
        return db.users.create({ email: body.email, passwordHash })
      })
      .post('/api/login', async ({ body }) => {
        return authenticate(db, body) // Application function, not part of the SDK.
      })
      .get('/api/users/:id', ({ params }) => db.users.find(params.id))
  },
  async stop() {
    // Finish context-owned work. The runner closes resources.
  },
})
```

Do not call `.listen()` inside a context module. The runner owns ports, readiness, and shutdown.
`create()` must await mandatory preparation. Do not hide incomplete preparation behind a background promise.
Real adapter-managed listen/stop preserves Elysia lifecycle hooks. The exact API targets a verified Elysia major version.

## 5. Conditional resource instead of a decorator with side effects

```ts
// src/shared/database.ts
import { defineResource } from 'monoripper'

export default defineResource({
  async start({ env }) {
    const db = createDatabaseClient(env.DATABASE_URL) // Application driver.
    await db.connect()
    return db
  },
  async stop(db) {
    await db.close()
  },
})
```

`resources.db.contexts` defines the contexts where a resource is permitted.
`contexts.user.resources` defines which permitted resources a particular context needs.
A mismatch is a declaration error. These are two separate contracts, not automatic dependency discovery.

```ts
async function initializeWorker(spec) {
  const opened = []
  try {
    for (const name of spec.context.resources) {
      const descriptor = spec.app.resources[name]
      assert(descriptor.contexts.includes(spec.contextName))
      const resource = await importTrustedEntry(descriptor.entry)
      const value = await resource.start({ env: spec.localEnv })
      opened.push({ name, resource, value })
    }
    const context = await importTrustedEntry(spec.context.entry)
    const app = await context.create({
      app: createAdapterBaseApp(),
      resources: resourceMap(opened),
      services: createServiceClient(spec),
    })
    await adapter.waitForModules(app)
    adapter.validateOwnership(app, spec.context.owns)
    await adapter.listen(app, { host: '127.0.0.1', port: 0 })
    return { app, context, opened }
  } catch (error) {
    await closeInReverseOrder(opened) // Record cleanup errors as well.
    throw error
  }
}
```

Each resource is created once **per worker**, not per node or cluster.
If `start` throws before returning a value, that function must clean up the partially created resource itself.
Shutdown order: stop accepting new requests → drain → context.stop → resources in reverse order.
Import-time application initialization is prohibited by convention. The prototype linter cannot prove the absence of all side effects.

## 6. Explicit calls to another context

```ts
const response = await services.fetch('billing', '/api/billing/accounts/42', {
  method: 'GET',
  timeoutMs: 1000,
})
if (!response.ok) throw new BillingUnavailableError(response.status)
```

The SDK propagates permitted request metadata and deadlines. The HTTP contract does not become typed automatically.
Local placement does not change a call into a direct import. The prototype uses the same network semantics everywhere.
Business 4xx/5xx results return as Response. Transport errors/timeouts throw a typed SDK error.
Do not retry mutating requests automatically. Import DTOs and schemas from shared/contracts.
Database sessions, JS closures, and Elysia Context objects do not cross process boundaries.

## 7. Linter

Proposed command: `monoripper check --app ./monoripper.app.ts`.
Run it in CI before build and always within `pack`. Reject packages with boundary violations.

```ts
function checkImports(project) {
  const graph = resolveImportGraph(project) // TS resolution, aliases, re-exports
  for (const edge of graph.edges) {
    if (owner(edge.from) === 'shared' && isContext(edge.to)) report(edge)
    if (differentContextOwners(edge.from, edge.to)) report(edge)
    if (edge.isComputedDynamicImport && !canResolve(edge)) reportUnsupported(edge)
  }
  assertNoHiddenContextReachability(graph) // Shared modules/barrels do not bypass the rule.
  return diagnostics // File, line, rule, import, and a clear correction.
}
```

Check import, export-from, literal require, literal dynamic import, and aliases.
The first version also prohibits context-to-context type imports. Shared types belong in shared modules.
Do not silently accept computed imports. Return a validation error or an explicit unsupported-feature error.
The linter is not a sandbox. It does not prove correctness of SQL, transactions, or arbitrary JS execution.

## 8. Errors

`OWNERSHIP_CONFLICT`, `IMPORT_BOUNDARY_VIOLATION`, `RESOURCE_NOT_ALLOWED`, `CONTEXT_START_FAILED`,
`CONTEXT_UNAVAILABLE` and `DEADLINE_EXCEEDED` contain a safe message and a correlation/operation ID.
Keep startup and stack details for the operator. Public HTTP clients receive a safe 5xx.
Never silently turn errors into successful empty Responses.

Document check: `python3 scripts/check-specs.py`.
Future executable checks: e01s01 in the [roadmap](../ROADMAP.md).
