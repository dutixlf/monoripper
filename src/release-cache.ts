import { chmod, mkdir, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MonoripperError, type AppDefinition } from './definitions'
import { defaultArchiveLimits, sha256Digest, validDigest } from './archive'
import { assertCompatible, elysiaDirectory, inspectRelease, releaseApp, validateReleaseManifest, type ReleaseManifest } from './release'
import { downloadRelease, type RegistryEndpoint } from './registry-client'

export interface CachedRelease { digest: string; manifest: ReleaseManifest; directory: string; app: AppDefinition }
const fail = (code: string, message: string): never => { throw new MonoripperError(code, message) }

async function syncDirectory(path: string) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/**
 * Read-only extracted releases at `<directory>/<project>/<hex>`. The cache root also links the runtime's Elysia and
 * Monoripper SDK, so release code resolves the same module instances as the worker without installing anything.
 */
export class ReleaseCache {
  private pending = new Map<string, Promise<CachedRelease>>()
  private constructor(readonly directory: string, private registry?: RegistryEndpoint, private maxArchiveBytes = defaultArchiveLimits.maxArchiveBytes) {}

  static async open(directory: string, registry?: RegistryEndpoint, maxArchiveBytes?: number): Promise<ReleaseCache> {
    await mkdir(join(directory, 'node_modules'), { recursive: true, mode: 0o755 })
    const link = join(directory, 'node_modules/elysia'), temporary = `${link}.${crypto.randomUUID()}`
    await symlink(elysiaDirectory(), temporary, 'dir')
    await rename(temporary, link)
    const sdk = join(directory, 'node_modules/monoripper')
    await mkdir(sdk, { recursive: true })
    const index = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './index.ts' : './index.js', import.meta.url))
    await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: 'monoripper', type: 'module', exports: { '.': './index.js' } }))
    await writeFile(join(sdk, 'index.js'), `export * from ${JSON.stringify(index)}\n`)
    return new ReleaseCache(directory, registry, maxArchiveBytes)
  }

  path(project: string, digest: string) { return join(this.directory, project, digest.slice('sha256:'.length)) }

  /** A complete cached release starts without the registry; otherwise it is downloaded from the configured origin only. */
  ensure(project: string, digest: string): Promise<CachedRelease> {
    if (!validDigest(digest)) return Promise.reject(new MonoripperError('INVALID_ARGUMENT', 'Invalid release digest'))
    const key = `${project}\0${digest}`
    const running = this.pending.get(key)
    if (running) return running
    const work = (async () => {
      const cached = await this.load(project, digest)
      if (cached) return cached
      if (!this.registry) return fail('RELEASE_NOT_FOUND', `Release ${digest} is not cached and no registry is configured`)
      return this.store(await downloadRelease(this.registry, project, digest, this.maxArchiveBytes), project)
    })()
    this.pending.set(key, work)
    work.finally(() => this.pending.delete(key)).catch(() => {})
    return work
  }

  /** Imports a local archive, for example a bootstrap release supplied with the container. */
  async importArchive(archive: Uint8Array, project?: string): Promise<CachedRelease> {
    return this.store(archive, project)
  }

  private async load(project: string, digest: string): Promise<CachedRelease | undefined> {
    const directory = this.path(project, digest)
    if (!existsSync(join(directory, 'manifest.json'))) return undefined
    const manifest: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    validateReleaseManifest(manifest)
    if (manifest.project !== project) fail('INVALID_RELEASE', 'Cached release belongs to another project')
    assertCompatible(manifest)
    return { digest, manifest, directory, app: releaseApp(manifest, directory) }
  }

  private async store(archive: Uint8Array, project?: string): Promise<CachedRelease> {
    const { manifest, files } = inspectRelease(archive)
    const digest = sha256Digest(archive)
    if (project !== undefined && manifest.project !== project) fail('INVALID_RELEASE', 'Release belongs to another project')
    assertCompatible(manifest)
    const existing = await this.load(manifest.project, digest)
    if (existing) return existing
    const final = this.path(manifest.project, digest)
    const stage = join(this.directory, `.extract-${crypto.randomUUID()}`)
    try {
      for (const file of files.values()) {
        const target = join(stage, file.path)
        await mkdir(dirname(target), { recursive: true, mode: 0o755 })
        const handle = await open(target, 'wx', 0o644)
        try { await handle.writeFile(file.data); await handle.sync() } finally { await handle.close() }
        await chmod(target, 0o444)
      }
      await mkdir(dirname(final), { recursive: true, mode: 0o755 })
      try { await rename(stage, final) } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error // Another promotion of the same digest won.
      }
      await syncDirectory(dirname(final))
    } finally { await rm(stage, { recursive: true, force: true }) }
    return (await this.load(manifest.project, digest))!
  }
}
