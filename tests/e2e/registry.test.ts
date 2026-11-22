import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer } from 'node:net'
import { publishRelease, startRegistry, type Registry } from '../../src/index'
import { createArchive, readArchive, sha256Digest } from '../../src/archive'
import { downloadRelease } from '../../src/registry-client'
import { ReleaseCache } from '../../src/release-cache'
import { buildRelease, fixtures, token, versionedApp } from '../helpers/releases'

const env = { read: 'TEST_REGISTRY_READ', write: 'TEST_REGISTRY_WRITE', otherRead: 'TEST_REGISTRY_OTHER_READ', otherWrite: 'TEST_REGISTRY_OTHER_WRITE' }
const credentials = { read: token(), write: token(), otherRead: token(), otherWrite: token() }
let directory: string, registry: Registry, archive: Uint8Array<ArrayBuffer>, digest: string
const blob = (project: string, value: string) => new URL(`/v1/projects/${project}/releases/${value}/blob`, registry.url)
const auth = (value: string) => ({ authorization: `Bearer ${value}` })

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'monoripper-registry-'))
  for (const [key, name] of Object.entries(env)) process.env[name] = credentials[key as keyof typeof credentials]
  registry = await startRegistry({ dataDir: join(directory, 'data'), limits: { maxArchiveBytes: 256 * 1024 },
    projects: { shop: { readTokenEnv: env.read, writeTokenEnv: env.write }, other: { readTokenEnv: env.otherRead, writeTokenEnv: env.otherWrite } } })
  const built = await buildRelease(versionedApp('v1'))
  archive = new Uint8Array(await readFile(built.file))
  digest = built.digest
})
afterAll(async () => {
  await registry?.stop()
  for (const name of Object.values(env)) delete process.env[name]
  await rm(directory, { recursive: true, force: true })
})

test('authorizes per project and access, and repeated or concurrent publication is safe', async () => {
  const endpoint = { url: registry.url.href, token: credentials.write }
  expect((await fetch(blob('shop', digest), { method: 'PUT', body: archive })).status).toBe(401)
  expect((await fetch(blob('shop', digest), { method: 'PUT', body: archive, headers: auth(credentials.read) })).status).toBe(401)
  expect((await fetch(blob('shop', digest), { method: 'PUT', body: archive, headers: auth(credentials.otherWrite) })).status).toBe(401)
  const [first, second] = await Promise.all([publishRelease(endpoint, archive), publishRelease(endpoint, archive)])
  expect([first.created, second.created].sort()).toEqual([false, true])
  expect(await publishRelease(endpoint, archive)).toMatchObject({ project: 'shop', digest, created: false })
  for (const value of [credentials.read, credentials.write]) {
    const response = await fetch(blob('shop', digest), { headers: auth(value) })
    expect(response.status).toBe(200)
    expect(sha256Digest(new Uint8Array(await response.arrayBuffer()))).toBe(digest)
  }
  expect((await fetch(blob('shop', digest), { headers: auth(credentials.otherRead) })).status).toBe(401)
  expect((await fetch(blob('shop', digest))).status).toBe(401)
  const metadata = await fetch(new URL(`/v1/projects/shop/releases/${digest}`, registry.url), { headers: auth(credentials.read) }).then(r => r.json())
  expect(metadata).toMatchObject({ project: 'shop', digest, bytes: archive.length, contexts: { api: { owns: [{ method: '*', path: '/api/*' }] } } })
  expect(JSON.stringify(metadata)).not.toContain('entries/')
  expect((await fetch(blob('shop', 'sha256:' + 'a'.repeat(64)), { headers: auth(credentials.read) })).status).toBe(404)
})

test('rejects digest mismatches, foreign projects, links, invalid archives, traversal and oversized uploads', async () => {
  const put = (project: string, value: string, body: BodyInit) => fetch(blob(project, value), { method: 'PUT', body, headers: auth(project === 'other' ? credentials.otherWrite : credentials.write) })
  const response = async (promise: Promise<Response>) => { const r = await promise; return [r.status, (await r.json()).error] }
  expect(await response(put('shop', 'sha256:' + 'b'.repeat(64), archive))).toEqual([400, 'DIGEST_MISMATCH'])
  expect(await response(put('other', digest, archive))).toEqual([422, 'PROJECT_MISMATCH'])
  const files = readArchive(archive)
  const linked = createArchive([...files.values()])
  // Replace the first entry type with a symbolic link inside an otherwise valid release.
  const raw = new Uint8Array(Bun.gunzipSync(linked))
  raw[156] = '2'.charCodeAt(0)
  raw.fill(0x20, 148, 156)
  raw.set(new TextEncoder().encode(raw.subarray(0, 512).reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\u0000 '), 148)
  const symlinked = Bun.gzipSync(raw)
  expect(await response(put('shop', sha256Digest(symlinked), symlinked))).toEqual([422, 'INVALID_RELEASE'])
  const junk = new TextEncoder().encode('not an archive')
  expect(await response(put('shop', sha256Digest(junk), junk))).toEqual([422, 'INVALID_RELEASE'])
  for (const path of ['/v1/projects/..%2F..%2Fetc/releases/x/blob', '/v1/projects/shop/releases/sha256:..%2F..%2Fx/blob', '/v1/projects/sh%00op/releases/x/blob']) {
    expect([400, 404]).toContain((await fetch(new URL(path, registry.url), { method: 'PUT', body: archive, headers: auth(credentials.write) })).status)
  }
  const large = new Uint8Array(300 * 1024)
  expect((await put('shop', sha256Digest(large), large)).status).toBe(413)
  expect(await readdir(join(directory, 'data/tmp'))).toEqual([])
  expect(await readdir(join(directory, 'data/projects/shop'))).toEqual([digest.slice(7)])
})

test('an interrupted upload commits nothing; an interrupted or tampered download caches nothing', async () => {
  const other = await buildRelease(versionedApp('interrupted'))
  const bytes = new Uint8Array(await readFile(other.file))
  await new Promise<void>((resolve, reject) => {
    const socket = connect(Number(registry.url.port), '127.0.0.1', () => {
      socket.write(`PUT /v1/projects/shop/releases/${other.digest}/blob HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${credentials.write}\r\nContent-Length: ${bytes.length}\r\n\r\n`)
      socket.write(bytes.subarray(0, 100))
      setTimeout(() => { socket.destroy(); resolve() }, 100)
    })
    socket.on('error', reject)
  })
  await Bun.sleep(200)
  expect((await fetch(blob('shop', other.digest), { headers: auth(credentials.read) })).status).toBe(404)
  expect(await readdir(join(directory, 'data/tmp'))).toEqual([])

  const cut = createServer(socket => socket.once('data', () => {
    socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${archive.length}\r\nContent-Type: application/gzip\r\n\r\n`)
    socket.write(archive.subarray(0, 50), () => setTimeout(() => socket.destroy(), 20))
  }))
  await new Promise<void>(resolve => cut.listen(0, '127.0.0.1', resolve))
  const partial = { url: new URL(`http://127.0.0.1:${(cut.address() as { port: number }).port}/`), stop: () => cut.close() }
  const tampered = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(bytes) })
  const cacheDirectory = join(directory, 'cache')
  try {
    await expect(downloadRelease({ url: partial.url.href, token: credentials.read }, 'shop', digest, 1 << 20)).rejects.toMatchObject({ code: 'DOWNLOAD_INTERRUPTED' })
    await expect(downloadRelease({ url: tampered.url.href, token: credentials.read }, 'shop', digest, 1 << 20)).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    await expect(downloadRelease({ url: tampered.url.href, token: credentials.read }, 'shop', digest, 10)).rejects.toMatchObject({ code: 'RELEASE_TOO_LARGE' })
    const broken = await ReleaseCache.open(cacheDirectory, { url: partial.url.href, token: credentials.read })
    await expect(broken.ensure('shop', digest)).rejects.toMatchObject({ code: 'DOWNLOAD_INTERRUPTED' })
    expect((await readdir(cacheDirectory)).filter(name => name !== 'node_modules')).toEqual([])
    const working = await ReleaseCache.open(cacheDirectory, { url: registry.url.href, token: credentials.read })
    expect((await working.ensure('shop', digest)).manifest.project).toBe('shop')
    const offline = await ReleaseCache.open(cacheDirectory, { url: 'http://127.0.0.1:9/', token: credentials.read })
    expect((await offline.ensure('shop', digest)).digest).toBe(digest) // A complete cached release needs no registry.
    await expect(downloadRelease({ url: 'http://example.com/', token: credentials.read }, 'shop', digest, 1)).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  } finally { partial.stop(); tampered.stop(true) }
})

test('a full disk returns 507, keeps nothing, and the registry keeps serving', async () => {
  const bash = Bun.which('bash')
  expect(bash).toBeTruthy()
  const data = join(directory, 'limited')
  const config = join(directory, 'limited.config.ts')
  await writeFile(config, `export default ${JSON.stringify({ dataDir: data, projects: { shop: { readTokenEnv: env.read, writeTokenEnv: env.write } } })}`)
  const large = await buildRelease({ ...versionedApp('large'), 'blob.ts': `export const blob = ${JSON.stringify(crypto.getRandomValues(new Uint8Array(96 * 1024)).toString())}\n`,
    'api.ts': versionedApp('large')['api.ts']!.replace("import { Elysia } from 'elysia'", "import { Elysia } from 'elysia'\nimport { blob } from './blob'\nconsole.log(blob.length)") })
  const largeBytes = new Uint8Array(await readFile(large.file))
  expect(largeBytes.length).toBeGreaterThan(64 * 1024)
  // RLIMIT_FSIZE with SIGXFSZ ignored makes oversized writes fail with EFBIG, as a full filesystem does.
  const child = Bun.spawn([bash!, '-c', `trap '' XFSZ; ulimit -f 48; exec "$0" "$@"`, process.execPath, join(fixtures, '../../src/cli.ts'), 'registry', '--config', config],
    { stdout: 'pipe', stderr: 'inherit', env: { ...process.env } })
  try {
    const reader = child.stdout.getReader()
    const line = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim().split('\n')[0]!)
    const endpoint = { url: line.url, token: credentials.write }
    await expect(publishRelease(endpoint, largeBytes)).rejects.toMatchObject({ code: 'STORAGE_FULL' })
    expect(await readdir(join(data, 'tmp'))).toEqual([])
    expect((await publishRelease(endpoint, archive)).created).toBe(true)
    expect((await fetch(new URL('/healthz', line.url))).status).toBe(200)
  } finally { child.kill('SIGTERM'); await child.exited }
}, 30_000)
