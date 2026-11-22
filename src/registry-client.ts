import { MonoripperError } from './definitions'
import { sha256Digest, validDigest } from './archive'
import { inspectRelease } from './release'

export interface RegistryEndpoint { url: string; token: string; /** PEM bundle for a private CA. */ ca?: string }
const loopback = new Set(['127.0.0.1', '[::1]', 'localhost'])
const fail = (code: string, message: string): never => { throw new MonoripperError(code, message) }

/** HTTPS, or plain HTTP to loopback only. No embedded credentials, query or fragment. */
export function registryBase(url: string): URL {
  let parsed: URL
  try { parsed = new URL(url) } catch { return fail('INVALID_CONFIG', 'Invalid registry URL') }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) fail('INVALID_CONFIG', 'Registry URL must not contain credentials, query or fragment')
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback.has(parsed.hostname))) fail('INVALID_CONFIG', 'Registry URL must use https unless it is loopback')
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed
}
export function validToken(token: unknown): token is string { return typeof token === 'string' && /^[\x21-\x7e]{32,512}$/.test(token) }

function request(endpoint: RegistryEndpoint, path: string, init: RequestInit & { timeoutMs?: number } = {}) {
  if (!validToken(endpoint.token)) fail('INVALID_CONFIG', 'Registry credential must be 32–512 printable ASCII characters')
  const url = new URL(path, registryBase(endpoint.url))
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${endpoint.token}`)
  return fetch(url, { ...init, headers, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 60_000),
    ...(endpoint.ca ? { tls: { ca: endpoint.ca } } : {}) })
}
async function failure(response: Response, action: string): Promise<never> {
  let code = 'REGISTRY_ERROR'
  try { const body = await response.json() as { error?: unknown }; if (typeof body.error === 'string' && /^[A-Z_]{1,64}$/.test(body.error)) code = body.error } catch { /* not JSON */ }
  return fail(code, `Registry ${action} failed with HTTP ${response.status}`)
}

export async function publishRelease(endpoint: RegistryEndpoint, archive: Uint8Array) {
  const { digest, manifest } = inspectRelease(archive)
  const response = await request(endpoint, `v1/projects/${manifest.project}/releases/${digest}/blob`, {
    method: 'PUT', body: new Blob([archive as Uint8Array<ArrayBuffer>]), headers: { 'content-type': 'application/gzip' }, timeoutMs: 300_000 })
  if (response.status !== 200 && response.status !== 201) return failure(response, 'upload')
  await response.body?.cancel()
  return { project: manifest.project, digest, ...(manifest.label ? { label: manifest.label } : {}), created: response.status === 201, bytes: archive.length }
}

/** Downloads into memory up to `maxBytes`, then verifies the digest. An interrupted download leaves nothing behind. */
export async function downloadRelease(endpoint: RegistryEndpoint, project: string, digest: string, maxBytes: number): Promise<Uint8Array> {
  if (!validDigest(digest)) fail('INVALID_ARGUMENT', 'Invalid release digest')
  let response: Response
  try { response = await request(endpoint, `v1/projects/${project}/releases/${digest}/blob`, { timeoutMs: 300_000 }) }
  catch (error) { if (error instanceof MonoripperError) throw error; return fail('REGISTRY_UNAVAILABLE', 'Registry is unreachable') }
  if (response.status !== 200) return failure(response, 'download')
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (declared > maxBytes) { await response.body?.cancel(); fail('RELEASE_TOO_LARGE', 'Release exceeds the configured size limit') }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for await (const chunk of response.body!) {
      size += chunk.length
      if (size > maxBytes) { await response.body?.cancel().catch(() => {}); fail('RELEASE_TOO_LARGE', 'Release exceeds the configured size limit') }
      chunks.push(chunk)
    }
  } catch (error) { if (error instanceof MonoripperError) throw error; fail('DOWNLOAD_INTERRUPTED', 'Release download was interrupted') }
  if (Number.isFinite(declared) && declared !== size) fail('DOWNLOAD_INTERRUPTED', 'Release download was truncated')
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  if (sha256Digest(bytes) !== digest) fail('DIGEST_MISMATCH', 'Downloaded release does not match its digest')
  return bytes
}
