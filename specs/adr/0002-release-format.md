# ADR 0002: release archives share Elysia and the SDK with the runtime

Status: accepted on 2026-11-22 under the user's authorization to complete the release plan.

A release bundles every context and resource entry with shared chunks and its npm dependencies, except `elysia`
and `monoripper`. Those two stay external and resolve to the runtime's own copies through links the release cache
creates next to the extracted files. The worker builds the base Elysia app, and context plugins must come from the
same Elysia instance; a second bundled copy would break that and hide version drift.

Consequences:

- The manifest pins Bun, the release ABI (1), Elysia, platform and architecture; a runtime refuses any mismatch.
- Bundling runs in a child process whose cwd is the app root, so source comments are app-relative and the digest
  does not depend on the checkout location. Full reproducibility across different toolchains is not promised.
- The archive is a deterministic ustar + gzip written and read by Monoripper itself, so extraction can reject links,
  devices, extensions and unsafe paths before touching the filesystem.
- Native addons and imports that are neither bundled nor builtins are rejected at pack time.
- A deployment's idempotency key is its intent (context, release, replicas), not the revision it read, so CI retries
  with the same request ID return the original operation. Scaling keeps the revision in its key.
