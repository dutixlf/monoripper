# Monoripper

Run selected Elysia contexts in separate Bun processes through one HTTP gateway.

**Status: prototype `0.1.0-prototype`, not production-ready. The package is unpublished.**
Selected contexts, background contexts, replicas, resource lifecycles, linting, local config, gRPC scale/status, worker recovery,
persistent desired state, health/readiness, Prometheus metrics, trusted-proxy client addresses, JSON logs, and relayed WebSockets are implemented,
as are immutable releases with a private registry, deploy/rollback of selected contexts, node agents on other machines,
request context with explicit cross-context calls, and bounded autoscaling. See [CHANGELOG.md](CHANGELOG.md).

## Requirements

Verified environment: Linux, Bun **1.3.13**, Elysia **1.4.30**.
With Nix, `nix develop` provides the pinned Bun, bun2nix, and Python. The flake pins nixpkgs `nixos-26.05` and fails evaluation if its Bun differs from `.bun-version`.
`elysia` is an exact peer dependency, so the application and the runtime share one Elysia copy.
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
Programmatic `serve` accepts an optional `startupSignal` to cancel initialization. After it resolves, use `Runtime.stop()`.
The CLI handles SIGTERM/SIGINT during worker startup as well as normal service. Cleanup failures remain errors.

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
- `http`, `lifecycle`, `recovery`, `control`, `admin`, `logging`, and `env` merge by field. `initial` is replaced as a whole.
- Config `dataDir` resolves relative to the config file. With programmatic serve, it resolves relative to root.
- Supply secrets through the environment or a local config file excluded from the release.
- Config is trusted executable TypeScript/JavaScript, not a sandbox. Configuration discovery and hot reload are not supported.
- `admin`, `logging`, and `http.trustedProxies` are described under [Health, metrics, client address, and logs](#health-metrics-client-address-and-logs).
- `http.websocket` is described under [WebSocket and streaming](#websocket-and-streaming).
- Unknown options are rejected rather than silently ignored.
- Release mode replaces `app` with `release`; see [Releases and deployment](#releases-and-deployment).
  `loadConfig` loads source-mode configs; `loadRuntimeConfig` loads either kind.

## gRPC and persistent state

Complete config: `examples/local/monoripper.control.config.ts`.
The server and CLI environments need the same 32–512 printable ASCII secret without whitespace. Do not commit it.

```sh
# Generate a credential in your private environment. The server and CLI must use the same value.
export MONORIPPER_CONTROL_TOKEN="$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')"
bun src/cli.ts serve --config examples/local/monoripper.control.config.ts

# In another terminal with the same credential:
bun src/cli.ts status --controller 127.0.0.1:50051 --project example
bun src/cli.ts scale --controller 127.0.0.1:50051 --project example --context user --replicas 3 --wait
bun src/cli.ts scale --controller 127.0.0.1:50051 --project example --context user --replicas 0 --wait
```

`--environment` defaults to development. `--token-env` defaults to MONORIPPER_CONTROL_TOKEN.
`scale` reads the revision from status. `--expected-revision` sets it explicitly.
The CLI prints requestId and expectedRevision to stderr before the request. For safe retries, repeat `--request-id` with its original `--expected-revision`.
Repeating the same ID/payload returns the same operation. Changed payloads with the same ID are rejected.
`operation --id <id> --wait` resumes waiting. Client timeouts do not cancel accepted operations.
Failed operations produce a nonzero CLI exit. GetStatus/GetOperation and SetContext are defined in `src/control.proto`, also delivered in dist.

SDK: `await connectControl({address, token, project, environment})`, then getStatus/setContext/getOperation/waitOperation, and always close.
Programmatic Runtime exposes the same methods without network transport. `status()` still returns workers.
Without `control.tls` the control API permits loopback only (127.0.0.1 or ::1); remote plaintext bind is prohibited.
With `control: { host, port, tokenEnv, tls: { certFile, keyFile } }` it binds any host, and clients pass `--ca-file <pem>` (SDK: `tls: { ca }`).
One credential provides administrative access to one configured project/environment. Separate roles are not implemented yet.
The admin credential is not persisted in state. Workers receive an empty value, not the secret.

`dataDir` enables persistence. With control, the default is `.monoripper/<project>/<environment>` relative to the application root.
Without control/dataDir, the runtime stays ephemeral. User config is not rewritten. Initial applies only to new state.
Each node needs its own directory on a local filesystem, not shared/NFS state. Persistence currently requires Linux/glibc and Bun FFI, verified on NixOS.
Kernel flock permits one writer and releases after a crash. PID/ready flags are not persisted as truth.
Snapshots use fsync + atomic rename + directory fsync. Corrupt state or changed context sets require explicit recovery/migration, not a silent reset.
Storage failures block mutations until restart. State retains up to 10000 idempotency records, then returns a capacity error without silently forgetting IDs.

Default recovery allows at most 3 attempts per context per controller lifetime, with a 100 ms delay.
Settings: `recovery.maxRestarts` and `recovery.backoffMs`. maxRestarts=0 disables automatic recovery.
A new operator operation or controller restart resets the budget. Exhaustion is visible in status. Desired count does not silently decrease.
Scale-down first removes replicas from routing, waits for body completion, and closes resources. Deadline expiration forcibly terminates the process and records an operation error.
Failed growth preserves old replicas and rolls back desired count. Failed disable cleanup does not re-enable the context.
Controller crashes can interrupt ingress. Long jobs/exactly-once are not guaranteed. Workers enforce their own cleanup limit after parent loss.
Cold startup remains fail-fast. If a saved context cannot start, control is not listening yet. Repair the dependency/state first, then restart the runtime.

## Routes and resources

Each method/path has one owner. `owns` supports exact paths and a trailing `/*`.
The `/api/user/*` prefix includes `/api/user` and its descendants, but not `/api/user-old`.
Cover HEAD/OPTIONS explicitly or use method `*`. Context ownership cannot overlap. WebSocket upgrades match as `GET`.
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

## WebSocket and streaming

A context serves WebSockets with plain Elysia `.ws()`. Clients connect to the normal public port; the gateway relays each socket to one replica.

```ts
// monoripper.app.ts: the upgrade request is a GET, so a GET (or *) rule must own the path.
live: { entry: './contexts/live.ts', owns: [{ method: 'GET', path: '/api/live/*' }] },

// contexts/live.ts: a typed Elysia plugin keeps .ws() inference; mount it on the provided app.
const live = new Elysia().ws('/api/live/updates', {
  open(ws) { ws.subscribe('servers'); ws.send({ type: 'hello' }) },
  message(ws, message) { ws.send(message) },
})
export default defineContext({ create: ({ app }) => app.use(live) })
```

The runnable version is [examples/websocket](examples/websocket/README.md). The worker passes Monoripper's limits to its own Bun server; do not call `.listen()`.

```ts
// Defaults. maxBufferedBytes defaults to 4 × maxMessageBytes and must be at least maxMessageBytes.
http: { websocket: { maxMessageBytes: 1048576, maxConnections: 1024, idleTimeoutSeconds: 120, maxBufferedBytes: 4194304 } }
```

- Handshake: the gateway chooses a ready replica round-robin like HTTP and opens the replica socket before it accepts the client.
  Path, query, `Sec-WebSocket-Protocol`, cookies, authorization and other end-to-end headers are forwarded.
  Hop-by-hop headers, the client's `Sec-WebSocket-Key`/`-Extensions`, `x-monoripper-*` and untrusted forwarding headers are removed, as for HTTP.
  `requestClientAddress(ws.data.request)` and the internal credential work as for HTTP. Headers from the replica's 101 response, such as `Set-Cookie`, reach the client.
- The replica chooses the subprotocol (Elysia `upgrade` can set `sec-websocket-protocol`). If it sets none, Bun selects the first offered value, as a direct Bun server would.
- A refused handshake (for example `beforeHandle` returning 401) returns the replica's status, headers and a body up to 64 KiB without upgrading.
  Transport failure returns 502 and a handshake slower than `lifecycle.requestTimeoutMs` returns 504. The request timeout covers the handshake only.
- Unowned paths return 404 and non-WebSocket upgrades (such as `h2c`) return 501. Malformed WebSocket handshakes return 400 `INVALID_UPGRADE`; more than `maxConnections` relayed or pending sockets return 503 `WEBSOCKET_LIMIT`.
- Text and binary messages, close codes and close reasons pass both ways. Compression is not negotiated.
  A replica message above `maxMessageBytes` closes the socket with 1009. A client message above it closes with 1009 up to 2 × `maxMessageBytes`;
  beyond that Bun drops the client connection (1006) before the relay sees the message. Both count as `message_too_big`. `maxRequestBodyBytes` applies to HTTP bodies only.
- Backpressure: when the client is slow, the relay stops reading from the replica until the client socket drains.
  Every place data can pile up is capped at `maxBufferedBytes`: the gateway's client buffer, the relay's queues in both directions (client data, pings and pongs), and the replica's own send buffer.
  When the gateway closes a socket, it stops honouring client backpressure and keeps reading the replica, so drain and shutdown do not wait on slow clients.
  A socket that exceeds it closes with 1013 (try again later) instead of growing or dropping messages, so the worst case is about 3 × `maxBufferedBytes` per socket plus kernel socket buffers.
  Budget memory as `maxConnections × maxBufferedBytes × 3`.
- Keepalive: the gateway pings idle clients and the relay pings its replica. A peer that stays silent for `idleTimeoutSeconds` (1–960) is closed; a silent replica counts as lost (1012).
- Lifecycle: scale-down/drain and runtime shutdown close the affected sockets with 1001 (going away) and wait for them within `shutdownTimeoutMs`. A replica that exits closes its sockets with 1012 (service restart); an invalid frame from the replica closes with 1011. Clients should reconnect on 1001, 1011, 1012 and 1013.
- Containment: an internal relay error closes only the affected socket with 1011 (`reason="internal_error"`); it never reaches the gateway process or other traffic.
- `ws.publish()` reaches subscribers of the same replica only. With several replicas, deliver change events to each replica (for example a database notification in a resource) and publish locally.

The replica-side client passes the [Autobahn TestSuite](https://github.com/crossbario/autobahn-testsuite) (301 cases, compression excluded): `nix shell nixpkgs#podman -c bun run test:autobahn` (opt-in, needs rootless Podman, pinned image digest).
`tests/compat/bun-websocket.test.ts` holds canaries for the Bun 1.3.13 quirks the relay works around; a failing canary after a Bun upgrade names the workaround to revisit.

Streaming HTTP responses, including Server-Sent Events, pass through without buffering. They are ordinary requests: `lifecycle.requestTimeoutMs` still bounds the whole response, so use WebSockets for connections that stay open.

## Checks and build

```sh
bun run typecheck
bun test tests
bun run build
bun dist/cli.js --help
bun run test:package
bun run test:landing
python3 scripts/check-specs.py
nix shell nixpkgs#podman -c bun run test:container   # opt-in, rootless Podman
```

Release, registry, deploy, multi-node and autoscaling suites are part of `bun test tests`. The registry full-disk test needs `bash`.

Tests run real processes, protobuf gRPC, SIGKILL/replay, HTTP body drain, and temporary PostgreSQL 18.
The PostgreSQL compatibility test requires a non-root user. The native postinstall for `@embedded-postgres/linux-x64` is explicitly allowed in package.json.
Other platforms are unverified. They can require permission for the corresponding native package.
Control tests exercise real SetContext/GetStatus/GetOperation/SetAutoscale.
After build, create a local npm archive with `bun pm pack --ignore-scripts --destination /tmp/monoripper-package`.
This command publishes nothing. Monoripper is distributed under the MIT license (see `LICENSE`).

### Nix

```sh
nix flake check                     # typecheck, full test suite (sandboxed embedded PostgreSQL), specs, bun.nix freshness, CLI
nix build .#tarball                 # result/monoripper.tgz: the same npm archive as `bun pm pack`
nix run . -- status --controller 127.0.0.1:50051 --project example
```

After changing dependencies, run `bun install` and then `bun run nix:lock` to regenerate `bun.nix`; the check rejects a stale file.
Consumers that build with Nix take this flake as an input and install `packages.<system>.tarball` as a tarball dependency (`"monoripper": "file:<path>/monoripper.tgz"`) until the package is published.

### Land a verified branch on main

Only after user authorization, from a clean feature branch:

```sh
bash scripts/land-branch.sh feat/local-control
```

The workflow runs typecheck, tests, package smoke, specs checks, and its own Git regression tests.
It then performs only a fast-forward and a normal atomic push of the verified commit to `main` and the source branch.
The first push without an existing `origin/main` is supported. History and the feature branch are preserved.
No force push, reset, or Git-guard disablement is used. Origin fetch/push URLs must match.
If push fails, the workflow does not roll back history. Resolve the cause, return to the feature branch, and retry.
This transfers source, not npm publication or application deployment. The workflow does not configure CI.

## Releases and deployment

A release is one immutable archive of the whole app, addressed by the `sha256` of its bytes. Contexts update independently.

```sh
monoripper pack --app ./monoripper.app.ts --out release.tar.gz --label 1.4.0      # runs check first
monoripper publish release.tar.gz --registry https://registry.internal/ --output release.json   # MONORIPPER_REGISTRY_TOKEN
monoripper deploy --controller controller.internal:50051 --ca-file ca.pem --project shop --environment staging \
  --release release.json --contexts user,billing --request-id "$CI_RUN" --wait
monoripper operation --controller ... --project shop --id <operationId> --wait   # resume after a lost connection
```

- **pack** bundles every context and resource entry with shared chunks and npm dependencies into a deterministic ustar+gzip archive:
  `manifest.json`, `entries/`, `chunks/`, `assets/` (files imported with `with { type: 'file' }`). `elysia` and `monoripper` stay external
  and resolve to the runtime's copies. Other unresolved imports and native addons are rejected. `.env` files and environment values are never inlined.
  The digest does not depend on where the checkout lives. The manifest pins Bun, Elysia, the release ABI, platform and architecture; runtimes refuse mismatches.
- **registry** (`monoripper registry --config`, [example](examples/releases/registry.config.ts)) stores releases per project with separate
  read (runtime) and write (CI) credentials. Uploads must match their digest and be a valid release of that project; repeats are safe;
  a full disk returns 507. Without `http.tls` it binds loopback only.
- **Release mode**: `defineConfig({ release, registry, initial, ... })` instead of `app`. `release` is an archive, a `release.json`, or `<project>@sha256:<hex>`,
  and applies to new state only. Releases are verified, extracted read-only under `<dataDir>/releases`, and start offline once cached.
  Each context runs in `<dataDir>/work/<context>`. Release mode always persists state (default `.monoripper/<project>/<environment>`).
- **deploy** sends `SetContext` with a digest (and optional `replicas`, default: unchanged). The runtime fetches it from its configured registry,
  checks ownership against every other serving context, starts the new replicas, then switches routing and replicas at once.
  Old replicas drain: running requests finish on the old release. Failures before the switch keep the old release; after a crash the durable
  operation replays. Old and new replicas must fit `capacity.maxReplicas` together, otherwise `CAPACITY_EXCEEDED`.
  Status shows `release`, `servingRelease` and `lastGoodRelease` per context; operations show `step` (`preparing`, `starting`, `switching`, `draining`).
- **Rollback** is a deploy of a retained digest. A release may add a context; deleting contexts is not supported.
- One operation per context; partial success exits nonzero. Reusing `--request-id` returns the original operations.

Walkthrough: [examples/releases](examples/releases/README.md). CI example: [examples/releases/ci.yml](examples/releases/ci.yml).

## Multiple nodes

`monoripper node --config` ([example](examples/cluster/node.config.ts)) runs an agent on another machine. The release-mode runtime opens
`cluster: { host, port, tls, caFile, tokenEnv, heartbeatTimeoutMs }` for agents; both sides verify each other's certificate against the private CA
and present the shared cluster credential. Agents report capacity and compatibility in heartbeats, download assigned digests from their registry,
and proxy authenticated gateway traffic (HTTP and WebSockets) to their loopback workers.

- Placement picks the node with the fewest replicas among this process (`capacity.maxReplicas`, 0 for gateway-only) and healthy, compatible agents with a free slot.
  Unreachable or untrusted agents are skipped. No suitable node: `CAPACITY_EXCEEDED`.
- Missing heartbeats withdraw a node's replicas and recovery places replacements. A reconnecting agent stops replicas the controller replaced,
  and a restarted controller stops every replica it did not assign. Withdrawal does not prove a process stopped, so during partitions a context can
  briefly run more processes than desired.
- `status` lists `nodes`, and workers carry `node`. There is still one controller and one ingress.

Walkthrough: [examples/cluster](examples/cluster/README.md).

## Request context and cross-context calls

The gateway adds an envelope to every request: a trace id (from a valid W3C `traceparent`, otherwise new), a request id and the remaining deadline.
Clients cannot supply any `x-monoripper-*` header. A context reads it with `requestContext(request)` → `{ traceId, requestId, deadline, caller?, claims }`.

```ts
import { defineContext, requestContext, services } from 'monoripper'

export default defineContext({
  create: ({ app }) => app.get('/api/orders/:id', async ({ request, params }) => {
    const user = await authenticate(request) // business auth stays in the context
    const invoice = await services.fetch(`/api/billing/invoices/${params.id}`, { request, claims: { sub: user.id } })
    return { order: params.id, invoice: await invoice.json() }
  }),
})
```

`services.fetch` goes through the gateway with the caller's trace and remaining deadline, routes by ownership (unknown paths 404),
sets `caller` to the calling context, and passes only claim names listed in `services: { claims: ['sub', 'tenant'] }`. It works across nodes.
Claims are only as trustworthy as the calling context's authentication.

## Autoscaling

```sh
monoripper autoscale --controller ... --project shop --context user --min 1 --max 6 --target-in-flight 8
monoripper autoscale --controller ... --project shop --context user --disable
```

The autoscaler samples the gateway's in-flight requests per context every `autoscale.intervalMs`. It scales up to
`ceil(average / targetInFlight)` over `upWindowMs`, and down only when the peak over the longer `downWindowMs` fits fewer replicas.
Changes wait for `cooldownMs`, move at most `maxStep`, stay within min/max and the capacity of connected nodes, and hold on stale data or active operations.
Defaults: `{ intervalMs: 1000, upWindowMs: 10000, downWindowMs: 60000, cooldownMs: 30000, maxStep: 2 }`.
While a policy exists, manual scaling returns `AUTOSCALE_ACTIVE`; deployments keep the count. Policies persist; `min` is at least 1.

## Container example

See [examples/container/README.md](examples/container/README.md) for the pinned non-root Debian/glibc image and rootless Podman commands.
Only HTTP is published. Administrative CLI commands run through `podman exec` and read a mounted secret.
The example supports read-only root, a persistent state volume, bounded resources and graceful SIGTERM, including blocked worker startup.

```sh
bun run test:container
```

This opt-in suite requires real rootless Podman. It checks boundaries, scale/recovery, recreation, hard kill and response drain.
It does not silently skip when the engine is unavailable. The example image runs a source app; a release-mode container takes `release` plus a mounted registry credential instead.

## Elysia examples and embedded PostgreSQL

```sh
bun run test:elysia
bun run test:elysia:postgres
```

Both commands use [self-contained Elysia examples](examples/elysia/README.md). No external checkouts or extra dependency installations are required.
The database-free check runs pagination, validation and error responses in two isolated replicas.

The PostgreSQL check:

1. Starts `embedded-postgres` 18 on a random loopback port with a new database and generated credentials.
2. Applies `examples/elysia/migration.sql` and runs the full example in two processes.
3. Verifies authenticated CRUD, unauthorized writes, cross-replica reads, duplicate 409, validation 422 and soft deletion.
4. Runs tags as a selected context, scales from 1→3 over gRPC, kills a worker, checks recovery, restarts the controller and verifies saved counts.
5. Disables tags to get 503 and proves that the disabled reports context was not imported.
6. Checks stored rows, stops workers/PostgreSQL and removes temporary database and controller state.

**One test PostgreSQL server serves all replicas.** Each worker owns a connection pool, not a database server.
`embedded-postgres` is a dev dependency, not part of the production runtime. `test:package` verifies its absence from the npm consumer.
The fixture does not use an external `DATABASE_URL`, an existing data directory or production services.
The PostgreSQL command requires a non-root user and the native dependency described under Checks and build.

## Background contexts

Declare `owns: []` for work without ingress, such as pollers and scheduled jobs. Registering any route in such a context fails startup.
`create` receives `signal`, which aborts when the replica starts stopping. Start loops in `onStart` without awaiting them, end them on `signal`, and await their completion in `onStop`.
Replicas are independent processes: a job that must run once needs `replicas: 1` and, across several runtimes, an external lock such as a database advisory lock.

## Health, metrics, client address, and logs

```ts
export default defineConfig({
  app: './monoripper.app.ts',
  initial: { api: { replicas: 2 }, jobs: { replicas: 1 } },
  http: { host: '0.0.0.0', port: 3000, trustedProxies: ['10.42.0.0/16'] },
  admin: { host: '0.0.0.0', port: 9090 },
  logging: { format: 'json' },
})
```

`admin` starts a second, unauthenticated listener. Keep it off the public network (bind loopback or restrict it with network policy).
- `GET /-/healthz`: 200 while the runtime runs, 503 during shutdown. Use it for liveness.
- `GET /-/readyz`: 200 when state storage is healthy and every context with desired replicas has at least one ready replica. Otherwise 503 with the waiting context names. Shutdown turns it 503 before draining.
- `GET /-/metrics`: Prometheus text. Runtime series use the `monoripper_` prefix: desired/ready replicas, restarts, in-flight bodies, responses by context/method/status, gateway-generated errors by code, and time to upstream headers.
  WebSockets add `monoripper_websocket_connections{context}`, `monoripper_websocket_opened_total{context}` and `monoripper_websocket_closed_total{context,reason}`,
  where `reason` is one of `client`, `upstream`, `going_away`, `upstream_lost`, `protocol_error`, `message_too_big`, `backpressure` or `internal_error`. Accepted handshakes count as status 101 in `monoripper_http_requests_total`.
  Labels never include paths, query strings, client addresses, or identities.
- A context may export `metrics()` returning Prometheus text for its replica. The runtime scrapes ready replicas over the internal credential, adds `context` and `worker` (PID) labels, and merges families.
  Replica exposition cannot use `monoripper_*` names or its own `context`/`worker` labels; invalid exposition is dropped and counted in `monoripper_worker_scrape_errors_total`.
  Each replica reports its own values: sum counters across workers, and use `max` for gauges that every replica computes from shared state.

The gateway removes `Forwarded`, `X-Real-IP`, and `X-Forwarded-*` request headers unless the direct peer matches `http.trustedProxies` (IP or CIDR).
For trusted peers it keeps them and walks `X-Forwarded-For` from the right to the first untrusted hop (falling back to `X-Real-IP`).
Contexts read the result with `requestClientAddress(request)`. Clients cannot supply its internal header.

`logging.format: 'json'` pipes worker stdout/stderr. JSON object lines gain `context` and `worker` fields; other lines become `{time, level, msg, context, worker}`.
Lines are bounded to 16 KiB. Runtime events (`worker_ready`, `worker_exited`, `diagnostic` codes) are JSON with `component: "monoripper"`.
Monoripper never writes access logs or diagnostic messages to the log stream. The default `text` format inherits worker output unchanged.

## Limitations

Controller and ingress HA, cross-replica WebSocket fan-out, incremental surge rollouts, automatic rollback on error rates and release garbage collection are absent.
HTTP streams stay bounded by the request timeout. Persistence saves desired state, not JS heaps or active requests.
The HTTP port does not provide authentication. Elysia contexts must implement business auth. Public services also need a standard TLS ingress.
Replicas share container or node limits. Exactly-once guarantees, strict singletons during partitions and isolation of untrusted code are not provided.
One cluster credential is shared by the controller and all agents ([ADR 0003](specs/adr/0003-cluster-trust.md)).
All e01–e03 automated checks pass. User UAT is still required. The container image embeds an example app; release-mode images take a bootstrap release instead.
Design and roadmap: [specs/README.md](specs/README.md).
