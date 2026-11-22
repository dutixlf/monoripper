import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MonoripperError } from './definitions'
import { assertKeys } from './config'
import { defaultArchiveLimits, validDigest, type ArchiveLimits } from './archive'
import { inspectRelease } from './release'
import { validToken } from './registry-client'
import { publicError } from './http'

export interface RegistryConfig {
  /** Persistent storage for published archives. Resolved relative to the config file. */
  dataDir: string
  http?: { host?: string; port?: number; tls?: { certFile: string; keyFile: string } }
  /** Each project has a separate read (runtime) and write (CI) credential, read from the named environment variables. */
  projects: Record<string, { readTokenEnv: string; writeTokenEnv: string }>
  limits?: { maxArchiveBytes?: number; maxExtractedBytes?: number; maxEntries?: number }
}
export interface Registry { readonly url: URL; stop(): Promise<void> }

const fail = (message: string): never => { throw new MonoripperError('INVALID_CONFIG', message) }
const nameRule = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const envRule = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateRegistryConfig(config: RegistryConfig): void {
  assertKeys(config, ['dataDir', 'http', 'projects', 'limits'], 'registry')
  if (typeof config.dataDir !== 'string' || !config.dataDir) fail('registry.dataDir is required')
  if (config.http !== undefined) {
    assertKeys(config.http, ['host', 'port', 'tls'], 'registry.http')
    if (config.http.port !== undefined && (!Number.isSafeInteger(config.http.port) || config.http.port < 0 || config.http.port > 65535)) fail('Invalid registry.http.port')
    if (config.http.tls !== undefined) {
      assertKeys(config.http.tls, ['certFile', 'keyFile'], 'registry.http.tls')
      if (typeof config.http.tls.certFile !== 'string' || typeof config.http.tls.keyFile !== 'string') fail('registry.http.tls needs certFile and keyFile')
    }
    const host = config.http.host ?? '127.0.0.1'
    if (!config.http.tls && !['127.0.0.1', '::1', 'localhost'].includes(host)) fail('A registry without TLS must bind loopback')
  }
  assertKeys(config.projects, Object.keys(config.projects ?? {}), 'registry.projects')
  if (!Object.keys(config.projects).length) fail('registry.projects must name at least one project')
  for (const [project, scope] of Object.entries(config.projects)) {
    if (!nameRule.test(project)) fail(`Invalid registry project: ${project}`)
    assertKeys(scope, ['readTokenEnv', 'writeTokenEnv'], `registry.projects.${project}`)
    if (!envRule.test(scope.readTokenEnv ?? '') || !envRule.test(scope.writeTokenEnv ?? '')) fail(`registry.projects.${project} must name credential environment variables`)
  }
  if (config.limits !== undefined) {
    assertKeys(config.limits, ['maxArchiveBytes', 'maxExtractedBytes', 'maxEntries'], 'registry.limits')
    for (const [name, value] of Object.entries(config.limits)) if (!Number.isSafeInteger(value) || value < 1) fail(`Invalid registry.limits.${name}`)
  }
}

export async function loadRegistryConfig(filename: string): Promise<RegistryConfig> {
  const path = resolve(filename)
  const config = (await import(pathToFileURL(path).href)).default as RegistryConfig
  validateRegistryConfig(config)
  const base = dirname(path)
  return { ...config, dataDir: resolve(base, config.dataDir),
    ...(config.http?.tls ? { http: { ...config.http, tls: { certFile: resolve(base, config.http.tls.certFile), keyFile: resolve(base, config.http.tls.keyFile) } } } : {}) }
}

const storageErrors = new Set(['ENOSPC', 'EFBIG', 'EDQUOT'])
class UploadError extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }

/**
 * Immutable content-addressed release storage. Uploads stream into a bounded private temp file, must match their digest,
 * must be a valid release of the addressed project, and commit with one atomic directory rename.
 */
export async function startRegistry(input: RegistryConfig): Promise<Registry> {
  validateRegistryConfig(input)
  const config = structuredClone(input)
  const limits: ArchiveLimits = { ...defaultArchiveLimits, ...config.limits }
  const credentials = new Map<string, { read: Buffer; write: Buffer }>()
  for (const [project, scope] of Object.entries(config.projects)) {
    const read = process.env[scope.readTokenEnv], write = process.env[scope.writeTokenEnv]
    if (!validToken(read) || !validToken(write)) fail(`Registry credentials for ${project} must be 32–512 printable ASCII characters`)
    if (read === write) fail(`Registry read and write credentials for ${project} must differ`)
    credentials.set(project, { read: Buffer.from(`Bearer ${read}`), write: Buffer.from(`Bearer ${write}`) })
  }
  const root = resolve(config.dataDir)
  // A registry-specific name, so a misconfigured dataDir can never point the cleanup at a shared directory such as /tmp.
  const uploads = join(root, '.monoripper-uploads')
  await rm(uploads, { recursive: true, force: true }) // Leftovers of interrupted uploads are never committed.
  await mkdir(uploads, { recursive: true, mode: 0o700 })
  const equal = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)
  const authorized = (request: Request, project: string, access: 'read' | 'write') => {
    const scope = credentials.get(project)
    const supplied = Buffer.from(request.headers.get('authorization') ?? '')
    if (!scope) return false
    return equal(supplied, scope.write) || (access === 'read' && equal(supplied, scope.read))
  }
  const releaseDirectory = (project: string, digest: string) => join(root, 'projects', project, digest.slice('sha256:'.length))

  async function upload(request: Request, project: string, digest: string): Promise<Response> {
    const declared = Number(request.headers.get('content-length') ?? NaN)
    if (declared > limits.maxArchiveBytes) return publicError(413, 'RELEASE_TOO_LARGE')
    const final = releaseDirectory(project, digest)
    if (await stat(join(final, 'release.tar.gz')).then(() => true, () => false)) {
      await request.body?.cancel().catch(() => {})
      return Response.json({ project, digest, created: false })
    }
    const stage = join(uploads, crypto.randomUUID())
    try {
      await mkdir(stage, { mode: 0o700 })
      const hasher = new Bun.CryptoHasher('sha256')
      const handle = await open(join(stage, 'release.tar.gz'), 'wx', 0o600)
      let size = 0
      try {
        if (!request.body) throw new UploadError(400, 'EMPTY_UPLOAD')
        try {
          for await (const chunk of request.body) {
            size += chunk.length
            if (size > limits.maxArchiveBytes) throw new UploadError(413, 'RELEASE_TOO_LARGE')
            hasher.update(chunk)
            for (let offset = 0; offset < chunk.length;) offset += (await handle.write(chunk, offset)).bytesWritten // Short writes happen near quotas.
          }
        } catch (error) {
          if (error instanceof UploadError || storageErrors.has((error as NodeJS.ErrnoException).code ?? '')) throw error
          throw new UploadError(400, 'UPLOAD_INTERRUPTED')
        }
        await handle.sync()
      } finally { await handle.close() }
      if ('sha256:' + hasher.digest('hex') !== digest) throw new UploadError(400, 'DIGEST_MISMATCH')
      let manifest
      try { manifest = inspectRelease(new Uint8Array(await readFile(join(stage, 'release.tar.gz'))), limits).manifest }
      catch { throw new UploadError(422, 'INVALID_RELEASE') }
      if (manifest.project !== project) throw new UploadError(422, 'PROJECT_MISMATCH')
      await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flush: true })
      await mkdir(dirname(final), { recursive: true, mode: 0o700 })
      try { await rename(stage, final) } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST' || code === 'ENOTEMPTY') return Response.json({ project, digest, created: false }) // Concurrent identical upload.
        throw error
      }
      const parent = await open(dirname(final), 'r')
      try { await parent.sync() } finally { await parent.close() }
      return Response.json({ project, digest, created: true, label: manifest.label ?? null, bytes: size }, { status: 201 })
    } catch (error) {
      await request.body?.cancel().catch(() => {})
      if (error instanceof UploadError) return publicError(error.status, error.code)
      if (storageErrors.has((error as NodeJS.ErrnoException).code ?? '')) return publicError(507, 'STORAGE_FULL')
      return publicError(500, 'STORAGE_ERROR')
    } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}) }
  }

  const tls = config.http?.tls ? { cert: readFileSync(config.http.tls.certFile, 'utf8'), key: readFileSync(config.http.tls.keyFile, 'utf8') } : undefined
  const server = Bun.serve({
    hostname: config.http?.host ?? '127.0.0.1', port: config.http?.port ?? 0, idleTimeout: 60,
    maxRequestBodySize: limits.maxArchiveBytes + 1, ...(tls ? { tls } : {}),
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/healthz') return Response.json({ status: 'ok' })
      const match = url.pathname.match(/^\/v1\/projects\/([^/]+)\/releases\/([^/]+?)(\/blob)?$/)
      if (!match || url.search) return publicError(404, 'NOT_FOUND')
      const [, project, digest, blob] = match as unknown as [string, string, string, string | undefined]
      if (!nameRule.test(project) || !validDigest(digest)) return publicError(400, 'INVALID_ADDRESS')
      const write = request.method === 'PUT'
      if (!write && request.method !== 'GET' && request.method !== 'HEAD') return publicError(405, 'METHOD_NOT_ALLOWED')
      if (!authorized(request, project, write ? 'write' : 'read')) return publicError(401, 'UNAUTHENTICATED')
      if (write) return blob ? upload(request, project, digest) : publicError(405, 'METHOD_NOT_ALLOWED')
      const directory = releaseDirectory(project, digest)
      if (blob) {
        const file = Bun.file(join(directory, 'release.tar.gz'))
        if (!await file.exists()) return publicError(404, 'NOT_FOUND')
        return new Response(file, { headers: { 'content-type': 'application/gzip', 'x-monoripper-digest': digest } })
      }
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
        const size = (await stat(join(directory, 'release.tar.gz'))).size
        return Response.json({ project, digest, bytes: size, label: manifest.label ?? null, compatibility: manifest.compatibility,
          contexts: Object.fromEntries(Object.entries(manifest.contexts as Record<string, { owns: unknown }>).map(([name, context]) => [name, { owns: context.owns }])) })
      } catch { return publicError(404, 'NOT_FOUND') }
    },
    error() { return publicError(500, 'INTERNAL_ERROR') },
  })
  return { url: new URL(server.url), async stop() { await server.stop(true) } }
}
