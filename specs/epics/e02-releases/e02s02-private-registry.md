# e02s02 — Private registry

## 1. Purpose
Store published releases by digest behind separate CI (write) and runtime (read) credentials.

## 2. User story
As a CI job, I publish a release once; every runtime and node agent downloads the same verified bytes.

## 3. Status and complexity
Implemented, automated checks passing, user UAT pending. 8 BCP, P0 risk from untrusted uploads and storage faults.

## 4. Dependencies
e02s01 archive format and manifest validation.

## 5. Inputs
`PUT/GET /v1/projects/{project}/releases/{digest}/blob`, `GET .../{digest}`, `GET /healthz`; `registry --config` with `dataDir`, `http`, `projects`, `limits`.

## 6. Outputs
Committed `<dataDir>/projects/<project>/<hex>/{release.tar.gz,manifest.json}`; metadata JSON with ownership but no file layout.

## 7. ADDED requirements
- Write requires the project's write credential; read accepts read or write. Unknown projects and bad credentials both return 401.
- Uploads stream into a bounded private file, must match the digest (`DIGEST_MISMATCH`), be a valid release (`INVALID_RELEASE`) of the addressed project (`PROJECT_MISMATCH`).
- Commit is one atomic directory rename; identical repeats or concurrent uploads return success without a second copy.
- Storage exhaustion returns 507 `STORAGE_FULL` and leaves nothing behind; the registry keeps serving.
- Runtime downloads verify size and digest; an interrupted or tampered download is never cached.

## 8. Invariants
Committed releases are immutable. There are no tags, search or deletion.

## 9. Startup interface
`monoripper registry --config registry.config.ts`, `startRegistry(config)`, `monoripper publish <file> --registry <url> --output release.json`.

## 10. Storage
Archives on a persistent volume; interrupted uploads under `.monoripper-uploads/` are deleted at startup.

## 11. Separation rationale
The registry is a mode of the same package so CI and runtimes need nothing else; storage is plain files.

## 12. Errors
401 `UNAUTHENTICATED`, 400 `INVALID_ADDRESS`/`DIGEST_MISMATCH`/`UPLOAD_INTERRUPTED`, 413 `RELEASE_TOO_LARGE`, 422 `INVALID_RELEASE`/`PROJECT_MISMATCH`, 507 `STORAGE_FULL`.

## 13. Security
Credentials compare in constant time and must differ per role. Without TLS the registry binds loopback only; clients require https except to loopback, never follow redirects, and accept no URL credentials.

## 14. Compatibility
Archive limits default to 256 MiB compressed, 1 GiB extracted, 10000 entries.

## 15. Implementation steps
1. Registry server and client → verify: `bun test tests/e2e/registry.test.ts`.

## 16. Test data
Releases built by `tests/helpers/releases.ts`, a crafted symlink archive, a raw TCP partial upload and partial download, and an `RLIMIT_FSIZE` registry child.

## 17. Acceptance criteria
- Auth matrix, repeat and concurrent publication, metadata.
- Digest mismatch, foreign project, link entry, junk archive, encoded traversal and oversized upload are refused; nothing remains in temp storage.
- Interrupted upload commits nothing; interrupted, tampered and oversized downloads fail and the cache stays empty; a complete cache serves offline.
- A write failure from the file size limit returns 507 and a later small upload succeeds.

## 18. Manual demonstration
Start `examples/releases/registry.config.ts`, publish a packed release, fetch its metadata with the read token.

## 19. Out of scope
Distributed storage, replication, retention policies, mutable tags, signing.

## 20. Gate and handoff
All entrypoints pass. Evidence: [e02-verify.yaml](../../verifications/e02-verify.yaml). User UAT pending.
