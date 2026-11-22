# e02s01 — Portable release

## 1. Purpose
Package the whole application into one immutable archive that runs without the source checkout or a dependency install.

## 2. User story
As a developer, I run `monoripper pack --app ./monoripper.app.ts --out release.tar.gz` and get a digest that identifies exactly those bytes.

## 3. Status and complexity
Implemented, automated checks passing, user UAT pending. 5 BCP, P1 risk from bundler output mapping and determinism.

## 4. Dependencies
e01 import checker and worker runner. Bun 1.3.13 `Bun.build` with splitting and metafile.

## 5. Inputs
App manifest, context and resource entries, their imports and `node_modules` dependencies, optional `--label`.

## 6. Outputs
`release.tar.gz` (deterministic ustar + gzip) with `manifest.json`, `entries/`, `chunks/`, `assets/`; result JSON with `project`, `digest`, `bytes`.

## 7. ADDED requirements
- `pack` runs the import check first and refuses violations (`PACK_CHECK_FAILED`).
- Every context and resource entry is bundled with shared chunks; outputs are mapped to entries through Bun's metafile, not file names.
- `elysia` and the Monoripper SDK stay external; repository-relative SDK imports are rewritten to the shared package.
- Any other unresolved import fails (`PACK_UNRESOLVED_IMPORT`); native addons are rejected (`INVALID_RELEASE`).
- The manifest pins Bun, the release ABI, Elysia, platform and architecture.
- Release mode (`release:` in config) serves an archive, a `release.json` or `<project>@sha256:<hex>` from a read-only cache.

## 8. Invariants
The digest is `sha256` of the archive bytes and does not depend on the checkout location. `.env`, environment values and source paths never enter the archive.

## 9. Startup interface
CLI `pack --app --out [--label]`, API `pack({ app, out, label })`. Runtime: `serve` with `release` instead of `app`.

## 10. Storage
`<dataDir>/releases/<project>/<hex>/` read-only files; `<dataDir>/releases/node_modules` links the runtime's Elysia and SDK; per-context work directories under `<dataDir>/work/`.

## 11. Separation rationale
Bundling runs in a child process with the app root as cwd, so Bun's source comments are relative to the app and the digest is location-independent.

## 12. Errors
`PACK_CHECK_FAILED`, `PACK_FAILED`, `PACK_UNRESOLVED_IMPORT`, `INVALID_RELEASE`, `INVALID_ARCHIVE`, `RELEASE_INCOMPATIBLE`, `RELEASE_NOT_FOUND`.

## 13. Security
The archive reader accepts regular files and directories only, rejects links, devices, FIFOs, pax/GNU extensions, unsafe or duplicate paths, and enforces compressed, extracted, entry and path limits before writing.

## 14. Compatibility
A release runs only on the exact Bun, Elysia, ABI, platform and architecture it was built with.

## 15. Implementation steps
1. Archive writer/reader → verify: `bun test tests/unit/archive.test.ts`.
2. Pack, manifest, release cache and release-mode serve → verify: `bun test tests/e2e/release-pack.test.ts`.
3. Installed-package pack and serve → verify: `bun run test:package`.

## 16. Test data
Generated apps in `tests/e2e/release-pack.test.ts` with a shared module, a bundled `node_modules` dependency, a file asset, a resource and a `.env` secret.

## 17. Acceptance criteria
- Two packs, also from another directory, produce the same digest.
- The release serves after the source directory is deleted, with dependency, asset and resource working.
- No secret value, `.env` content or source path appears in the archive; `process.env` references stay references.
- Boundary violations, native addons and incompatible releases are refused.

## 18. Manual demonstration
`bun src/cli.ts pack --app examples/local/app.ts --out /tmp/release.tar.gz`, then serve it with `examples/releases/runtime.config.ts`.

## 19. Out of scope
Native addons, arbitrary runtime dependencies, reproducibility across different toolchains, release garbage collection.

## 20. Gate and handoff
All entrypoints and the full suite pass. Evidence: [e02-verify.yaml](../../verifications/e02-verify.yaml). User UAT pending.
