import { expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { monoripper } from '../../src/index'
import { createArchive, readArchive, sha256Digest } from '../../src/archive'
import { inspectRelease, pack } from '../../src/release'
import { sdk } from '../helpers/releases'

const secret = 'PACK_SECRET_VALUE_' + crypto.randomUUID()
async function writeApp(directory: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true })
    await writeFile(join(directory, path), content.replaceAll('{{sdk}}', sdk))
  }
  await mkdir(join(directory, 'node_modules'), { recursive: true })
  await symlink(join(import.meta.dir, '../../node_modules/elysia'), join(directory, 'node_modules/elysia'))
}
const app = {
  'app.ts': `import { defineApp } from '{{sdk}}'
export default defineApp({ project: 'packed', contexts: {
  api: { entry: './contexts/api/index.ts', owns: [{ method: 'GET', path: '/api/*' }], resources: ['clock'] },
  jobs: { entry: './contexts/jobs/index.ts', owns: [] },
}, resources: { clock: { entry: './resources/clock.ts', contexts: ['api'] } } })
`,
  'shared/format.ts': `import pad from 'fixture-pad'\nexport const format = (value: string) => pad(value, 8)\n`,
  'contexts/api/index.ts': `import { Elysia } from 'elysia'
import { defineContext, requestClientAddress } from '{{sdk}}'
import { format } from '../../shared/format'
import greeting from './greeting.txt' with { type: 'file' }
export default defineContext({ create: ({ app, resources }) => app.use(new Elysia()
  .get('/api/info', async ({ request }) => ({ formatted: format('x'), asset: await Bun.file(new URL(greeting, import.meta.url)).text(),
    clock: resources.get<{ started: string }>('clock').started, secret: process.env.PACKED_SECRET ?? null, cwd: process.cwd(),
    client: requestClientAddress(request) !== undefined }))) })
`,
  'contexts/api/greeting.txt': 'hello from an asset\n',
  'contexts/jobs/index.ts': `import { format } from '../../shared/format'\nexport default { create: ({ app }) => { format('job'); return app } }\n`,
  'resources/clock.ts': `export default { start: () => ({ started: 'clock-ok' }) }\n`,
  'node_modules/fixture-pad/package.json': JSON.stringify({ name: 'fixture-pad', type: 'module', main: 'index.js' }),
  'node_modules/fixture-pad/index.js': `export default (value, size) => value.padStart(size, '.')\n`,
  '.env': `PACKED_SECRET=${secret}\n`,
}

test('pack builds a deterministic, self-contained release that runs without the source checkout', async () => {
  const work = await mkdtemp(join(tmpdir(), 'monoripper-pack-test-'))
  const source = join(work, 'source'), elsewhere = join(work, 'elsewhere')
  const before = process.env.PACKED_SECRET
  process.env.PACKED_SECRET = secret
  let runtime: Awaited<ReturnType<typeof monoripper.serve>> | undefined
  try {
    await writeApp(source, app)
    const first = await pack({ app: join(source, 'app.ts'), out: join(work, 'first.tar.gz'), label: '1.0.0' })
    const second = await pack({ app: join(source, 'app.ts'), out: join(work, 'second.tar.gz'), label: '1.0.0' })
    expect(second.digest).toBe(first.digest)
    await writeApp(join(work, 'moved/deeper/checkout'), app)
    expect((await pack({ app: join(work, 'moved/deeper/checkout/app.ts'), out: join(work, 'moved.tar.gz'), label: '1.0.0' })).digest).toBe(first.digest)
    const bytes = new Uint8Array(await readFile(first.file))
    expect(first.digest).toBe(sha256Digest(bytes))
    const { manifest, files } = inspectRelease(bytes)
    const paths = [...files.keys()]
    expect(paths.some(path => path.startsWith('chunks/'))).toBe(true) // shared/format.ts is shared by both contexts.
    expect(paths.some(path => path.startsWith('assets/greeting'))).toBe(true)
    expect(paths.every(path => path === 'manifest.json' || /^(entries|chunks|assets)\//.test(path))).toBe(true)
    expect(manifest).toMatchObject({ project: 'packed', label: '1.0.0', compatibility: { bun: Bun.version, monoripper: 1, elysia: '1.4.30', platform: process.platform, arch: process.arch } })
    expect(manifest.contexts.jobs!.owns).toEqual([])
    const everything = new TextDecoder().decode(Buffer.concat([...files.values()].map(file => file.data)))
    expect(everything).not.toContain(secret)
    expect(everything).not.toContain(source)
    expect(everything).not.toContain('PACKED_SECRET=')
    expect(everything).toContain('process.env.PACKED_SECRET')
    expect(everything).toContain('from "elysia"')
    expect(everything).toContain('from "monoripper"')
    expect(everything).not.toContain('grpc')

    await mkdir(elsewhere)
    await cp(first.file, join(elsewhere, 'release.tar.gz'))
    await rm(source, { recursive: true, force: true })
    runtime = await monoripper.serve({ release: join(elsewhere, 'release.tar.gz'), root: elsewhere, initial: { api: { replicas: 1 }, jobs: { replicas: 1 } }, http: { port: 0 } })
    const info = await fetch(new URL('/api/info', runtime.url)).then(response => response.json())
    expect(info).toMatchObject({ formatted: '.......x', asset: 'hello from an asset\n', clock: 'clock-ok', secret, client: true })
    expect(info.cwd).toStartWith(join(elsewhere, '.monoripper/packed/development/work'))
    expect(runtime.getStatus().contexts.map(context => [context.name, context.release, context.servingRelease])).toEqual([['api', first.digest, first.digest], ['jobs', first.digest, first.digest]])
    expect(runtime.status().every(worker => worker.release === first.digest)).toBe(true)
  } finally {
    await runtime?.stop()
    if (before === undefined) delete process.env.PACKED_SECRET; else process.env.PACKED_SECRET = before
    await rm(work, { recursive: true, force: true })
  }
}, 30_000)

test('pack rejects boundary violations and native addons; serve rejects incompatible releases', async () => {
  const work = await mkdtemp(join(tmpdir(), 'monoripper-pack-reject-'))
  try {
    await writeApp(join(work, 'coupled'), {
      'app.ts': `export default { project: 'coupled', contexts: { a: { entry: './a/index.ts', owns: [{ method: '*', path: '/a/*' }] }, b: { entry: './b/index.ts', owns: [{ method: '*', path: '/b/*' }] } } }\n`,
      'a/index.ts': `import '../b/index'\nexport default { create: ({ app }) => app }\n`,
      'b/index.ts': `export default { create: ({ app }) => app }\n`,
    })
    await expect(pack({ app: join(work, 'coupled/app.ts'), out: join(work, 'x.tar.gz') })).rejects.toMatchObject({ code: 'PACK_CHECK_FAILED' })
    await writeApp(join(work, 'native'), {
      'app.ts': `export default { project: 'native', contexts: { a: { entry: './a/index.ts', owns: [{ method: '*', path: '/a/*' }] } } }\n`,
      'a/index.ts': `import addon from './addon.node'\nexport default { create: ({ app }) => app.get('/a', () => String(addon)) }\n`,
      'a/addon.node': 'not really native',
    })
    await expect(pack({ app: join(work, 'native/app.ts'), out: join(work, 'y.tar.gz') })).rejects.toMatchObject({ code: 'INVALID_RELEASE' })

    await writeApp(join(work, 'ok'), { 'app.ts': `export default { project: 'ok', contexts: { a: { entry: './a.ts', owns: [{ method: '*', path: '/a/*' }] } } }\n`, 'a.ts': `export default { create: ({ app }) => app }\n` })
    const built = await pack({ app: join(work, 'ok/app.ts'), out: join(work, 'ok.tar.gz') })
    const files = readArchive(new Uint8Array(await readFile(built.file)))
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')!.data))
    manifest.compatibility.bun = '0.0.1'
    files.set('manifest.json', { path: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) })
    await writeFile(join(work, 'old.tar.gz'), createArchive([...files.values()]))
    await expect(monoripper.serve({ release: join(work, 'old.tar.gz'), root: work, initial: {}, http: { port: 0 } })).rejects.toMatchObject({ code: 'RELEASE_INCOMPATIBLE' })
    await expect(monoripper.serve({ release: 'ok@sha256:' + '0'.repeat(64), root: work, initial: {}, http: { port: 0 } })).rejects.toMatchObject({ code: 'RELEASE_NOT_FOUND' })
  } finally { await rm(work, { recursive: true, force: true }) }
}, 30_000)
