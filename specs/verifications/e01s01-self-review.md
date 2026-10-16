# e01s01 — self-review

Purpose: record the scope of the initial prototype self-review.
This is not an independent review or a complete git-diff security gate. Monoripper does not have a Git repository yet.

## Reviewed

- Correctness: selected/disabled contexts, ownership conflicts, lifecycle, startup/stop failures, timeouts, round-robin, and no live workers after shutdown.
- HTTP: body/query/params, schema errors, middleware, cookies, redirects, raw compressed bytes, oversized uploads, and ambiguous paths.
- Security boundaries: loopback plus a random worker credential. Direct unauthenticated requests return 403. External internal/hop headers are removed.
- SSRF/commands: HTTP upstream uses loopback, a validated worker port, and HTTP protocol. Subprocesses use argument arrays without a shell.
- Errors: unhandled exceptions do not reach clients. The operator callback is separate from the public response.
- Config: unknown parameters are rejected. Loads do not share mutable manifest/config objects.
- Supply chain: versions are pinned and bun.lock exists. The protobufjs postinstall remained blocked and was unnecessary for transport smoke tests.
- Packaging: Elysia remains a declared dependency, not another copy inside the worker bundle. The archive contains only package metadata, README, and dist.
- Backend provenance: the external checkout is clean. AGPL code appears only in a temporary integration bundle, not the npm archive.

## Reproduced findings and fixes

1. The default Elysia response to an unhandled exception exposed its private message.
   Regression: `tests/e2e/http-semantics.test.ts`, exception privacy and operator diagnostics.
2. The import cache shared one manifest object across multiple loadConfig calls.
   Regression: `tests/unit/config.test.ts`, mutating one instance does not change another.

RED → GREEN was reproduced in the terminal. No separate test/fix commits exist because VCS is not initialized.

## Intentional limitations

- The linter is a static best-effort guard, not a sandbox. Computed imports are rejected. npm internals are not analyzed.
- With entry files in one directory, the default boundary is the file itself. A complete directory boundary requires explicit context.root.
- State checks, control API authorization, registry extraction, and distributed metadata are not applicable yet because these features do not exist.
- Async hooks use pinned Elysia 1.4.30 internals. Elysia upgrades require another compatibility test.
- Orchestration/graph traversal functions longer than 20 lines remain in small modules. No general classes or interfaces were added for style alone.
- No hard isolation of untrusted code, protection against all DoS, or absence of leaks in user error handlers/loggers is claimed.
- User UAT, formal diff-based security review, and NFR/performance gates are incomplete. Production readiness is not claimed.

Checks: `bun run typecheck`, `bun test tests`, `bun run test:package`.
One final run result: [verification record](e01s01-verify.yaml).
