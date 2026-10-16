# Releases, registry, updates, and CI/CD

Status: pseudocode and planned CLI. Purpose: define code delivery without Git in the runtime or production builds.
Basis: [architecture](../tech-architecture/tech-stack.md), [control](runtime.md).

## 1. Release format

One release contains the entire application build. Deployment selects contexts without necessarily updating the entire application.
An archive uses `sha256:<hex>` of its exact bytes as its address. A version label is human-readable, not identity or a mutable target.

```text
release.tar.gz
  manifest.json
  entries/user.js
  entries/billing.js
  resources/db.js
  chunks/...
  assets/...              # Explicitly included runtime resources only.
```

```ts
// manifest.json does NOT contain its own archive digest, to avoid a hash cycle.
{
  schemaVersion: 1,
  project: 'shop',
  label: '0.1.0',
  compatibility: { bun: '<verified version/range>', monoripper: '<SDK ABI>',
                   elysia: '<verified major>', platform: 'linux', arch: 'x64' },
  contexts: {
    user: { entry: 'entries/user.js', owns: [/* ownership */], resources: ['db'] },
    billing: { entry: 'entries/billing.js', owns: [/* ownership */], resources: ['db'] },
  },
  resources: { db: { entry: 'resources/db.js', contexts: ['user', 'billing'] } },
}
```

Exclude business data, `.env`, keys, CI tokens, registry credentials, and `.git`.
The initial bundle format rejects native addons, unresolved imports, and arbitrary runtime dependencies with diagnostics.
Support such applications through a separate format, not implicit package installation in production.

## 2. Pack

```ts
async function pack(appFile, outFile) {
  const app = await loadDeclarationOnly(appFile)
  validateAppManifest(app)
  await checkImportBoundaries(app) // Mandatory check.
  const stage = await newPrivateTempDirectory()
  try {
    const build = await Bun.build({
      entrypoints: allContextAndResourceEntries(app),
      target: 'bun', format: 'esm', splitting: true,
      outdir: stage + '/build',
    })
    if (!build.success) throw new BuildFailed(build.logs)
    const mapped = mapActualBuildOutputsToEntries(build, app)
    assertOnlyPackagedImportsOrBunBuiltins(mapped)
    await copyAllowlistedAssets(app, stage)
    await writeValidatedManifest(stage, mapped)
    await createDeterministicArchive(stage, outFile)
    return { digest: await sha256File(outFile), project: app.project }
  } finally {
    await removePrivateTempDirectory(stage)
  }
}
```

`mapActualBuildOutputsToEntries` is the responsibility of pack. Do not assume output filenames match source filenames.
Include shared chunks in the package. The bundle must not depend on the checkout or developer node_modules.
SDK defineContext/defineResource helpers must be bundle-safe. Use plain descriptors without a global registry or `instanceof` across SDK copies.
A separate smoke test verifies Elysia plugin builds against the adapter.
A running release does not read source from the old working directory.

A deterministic archive sorts entries, normalizes timestamps/permissions, and omits host uid/gid.
The digest reliably identifies an artifact. Fully reproducible builds across arbitrary environments without a fixed toolchain are not promised.

## 3. Minimal registry

HTTP API in a separate mode of the same npm package:

```text
PUT /v1/projects/{project}/releases/{digest}/blob    # upload, write credential
GET /v1/projects/{project}/releases/{digest}/blob    # download, read credential
GET /v1/projects/{project}/releases/{digest}         # validated metadata
GET /healthz
```

```ts
async function publishBlob(request, project, digest) {
  authorizeRegistry(request, project, 'write')
  validateDigestSyntax(digest)
  const temp = await streamIntoBoundedTempFile(request.body)
  try {
    assertEqual(await sha256File(temp), digest)
    const manifest = await inspectArchiveSafely(temp)
    assertEqual(manifest.project, project)
    validateReleaseManifest(manifest)
    await commitBlobAtomicallyIfAbsent(temp, project, digest)
    return { project, digest } // Repeating identical bytes is safe.
  } finally {
    await cleanupTempIfPresent(temp)
  }
}
```

Storage: `registry/projects/<validated-project>/<digest>/...`, on a persistent volume.
Prevent traversal through project/digest. Limit compressed and extracted sizes, entry count, and path length.
Reject absolute paths, `..`, symlinks/hardlinks, device files, and duplicate archive paths.
Downloads also require read authorization. Extract metadata from the verified archive rather than publishing an independently replaceable version.
The first registry has no search, semver resolver, mutable tags, dependency graph, or distributed storage.
The prototype does not automate release deletion. Future GC must account for serving/desired/last-good references across all environments.

## 4. Node preparation

```ts
async function ensureRelease(project, digest) {
  if (cache.hasVerifiedRelease(project, digest)) return cache.path(project, digest)
  const archive = await registry.downloadFromConfiguredOrigin(project, digest)
  assertEqual(await sha256File(archive), digest)
  const temp = await safelyExtractIntoNewDirectory(archive)
  const manifest = await readAndValidateManifest(temp)
  assertRuntimeCompatibility(manifest)
  await atomicallyPromoteIntoReadOnlyReleaseCache(temp, project, digest)
  return cache.path(project, digest)
}
```

The operator configures and allowlists the registry origin. Arbitrary deployment URLs must not turn the controller into an SSRF proxy.
Do not run `bun install`, build scripts, or modify release files on the node.
Each replica gets a separate writable work/data directory outside the read-only release cache.
A complete cached release can start without the registry. An incomplete download is not a cache hit.

## 5. Context version switch

```ts
async function deployContext(operation) {
  const previous = snapshotServingAndDesired(operation.context)
  const candidates = []
  try {
    const release = await ensureRelease(operation.project, operation.targetDigest)
    validateNewOwnershipAgainstOtherServingContexts(release, operation.context)
    assertCapacityForTemporaryOldAndNewReplicas(operation)
    await persistPhase(operation, 'starting', { previous })
    for (let i = 0; i < operation.targetReplicas; i++) {
      candidates.push(await agent.startAndWaitReady(release, operation.context))
    }
    assertOperationGenerationCurrent(operation)
    await persistPhase(operation, 'switching')
    routing.atomicReplaceContext(operation.context, candidates, release.ownership)
    await persistServingAndLastGood(operation, release.digest)
    await persistPhase(operation, 'draining')
    await drainPreviousWorkers(previous.workers)
    await finishOperation(operation, 'succeeded')
  } catch (error) {
    if (!routing.hasSwitchedFor(operation)) {
      await stopCandidates(candidates)
      await restoreDesiredForSameGeneration(previous, operation)
      await finishOperation(operation, 'failed', safeOperatorError(error))
    } else {
      // After the switch, do not pretend that nothing changed.
      // Persist the actual phase and status. Reconciliation/the operator completes recovery.
      await recordPostSwitchFailureAndReconcile(operation, error)
    }
  }
}
```

The first algorithm prepares the complete new serving set, then performs one atomic switch on the single gateway.
Temporary old + new capacity is required. If unavailable, reject the update rather than killing old replicas to simulate success.
Incremental rollout with maxSurge/maxUnavailable can follow later.
Expose drain failures as operation warnings/details. Business requests can be aborted at their deadline.
After a crash between switch and persistence, the live routing snapshot is lost. Recover from the durable operation and readiness, not assumed code progress.
Publishing a new digest does not trigger deployment automatically.

Rollback is a normal deployment of a retained digest, not file modification or database rollback.
Automatic error-rate rollback after a successful switch is outside the prototype. It needs observation windows and application-specific criteria.
Readiness can miss business defects. Ready does not mean the new version is semantically correct.

## 6. CI/CD

```sh
# PLANNED commands, not implemented yet.
# CI uses a fixed Bun toolchain and the application lockfile.
bun install --frozen-lockfile
bun run test
bun run typecheck
bunx monoripper check --app ./monoripper.app.ts
bunx monoripper pack --app ./monoripper.app.ts --out ./release.tar.gz
bunx monoripper publish ./release.tar.gz \
  --registry https://registry.example.com --output ./release.json

# CD uses the same release.json job artifact without rebuilding.
bunx monoripper deploy --controller controller.internal:50051 \
  --project shop --environment staging --release ./release.json \
  --contexts user,billing --wait

# Production uses the same digest after verification/approval.
bunx monoripper deploy --controller controller.internal:50051 \
  --project shop --environment production --release ./release.json \
  --contexts user,billing --wait
```

Pin the CLI version in real pipelines. Do not fetch arbitrary latest versions through bunx.
Upload and deployment credentials are separate CI secrets. Read them from the environment/files, not logged command arguments.
`release.json` contains schemaVersion, project, digest, and safe build metadata, without secrets.
For multiple contexts, the CLI returns separate operations. Atomic distributed deployment of the group is not promised.
The pipeline serializes production deployments per environment so a late older build cannot overwrite a newer one.
The deploy CLI creates a requestId, saves operation IDs, and resumes waiting after network failure.
Deployment CI runners use the private network or a VPN. Do not expose unprotected control gRPC to the internet.
`--wait` succeeds after the switch and lifecycle completion. A wait timeout does not cancel an accepted operation.

## 7. Container

The image contains pinned Bun + monoripper, not one permanently embedded application release.
Supply declarative configuration and a pinned bootstrap release at startup. Mount credentials separately.
Volume `/var/lib/monoripper` contains state/cache/work directories. It is not a shared database for multiple controllers.
Proposed command: `monoripper serve --config /etc/monoripper/runtime.json --release sha256:...`.
Publish the HTTP port. Restrict control and agent data endpoints to the allowed network.
Run as a non-root user, without privileged mode or a Docker socket.
The production image does not need Git or a native dependency compiler.
Updating Bun or monoripper itself requires image replacement, not a context deployment.
Without a second ingress instance, container replacement has no zero-downtime guarantee.

Document check: `python3 scripts/check-specs.py`.
Next step: e02 after the local lifecycle. See the [roadmap](../ROADMAP.md).
