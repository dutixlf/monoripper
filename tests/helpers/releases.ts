import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pack } from '../../src/release'

export const sdk = join(import.meta.dir, '../../src/index.ts')
export const fixtures = join(import.meta.dir, '../fixtures')
export const token = () => crypto.randomUUID() + crypto.randomUUID()

/** Writes an app directory from file contents and packs it. `{{sdk}}` in sources becomes the SDK path. */
export async function buildRelease(files: Record<string, string>, label?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-app-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(directory, path)), { recursive: true })
      await writeFile(join(directory, path), content.replaceAll('{{sdk}}', sdk))
    }
    await mkdir(join(directory, 'node_modules'), { recursive: true })
    await symlink(join(import.meta.dir, '../../node_modules/elysia'), join(directory, 'node_modules/elysia'))
    const out = join(await mkdtemp(join(tmpdir(), 'monoripper-release-')), 'release.tar.gz')
    return await pack({ app: join(directory, 'app.ts'), out, ...(label ? { label } : {}) })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

/** An app whose responses carry `version`; `broken` contexts fail startup, `paths` moves ownership, `extra` adds a context. */
export function versionedApp(version: string, options: { broken?: string[]; paths?: Record<string, string>; extra?: boolean } = {}) {
  const paths = { api: '/api', billing: '/billing', extra: '/extra', ...options.paths }
  const names = ['api', 'billing', ...(options.extra ? ['extra'] : [])] as (keyof typeof paths)[]
  const context = (name: string, path: string) => `import { Elysia } from 'elysia'
import { defineContext } from '{{sdk}}'
export default defineContext({ create: ({ app }) => {
  ${options.broken?.includes(name) ? `throw new Error('${name} ${version} is broken')` : ''}
  return app.use(new Elysia()
    .get('${path}/version', () => ({ context: '${name}', version: '${version}', pid: process.pid }))
    .get('${path}/slow', () => new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(new TextEncoder().encode('${version}:'))
      await Bun.sleep(Number(process.env.SLOW_MS ?? 600))
      controller.enqueue(new TextEncoder().encode('done'))
      controller.close()
    } }))))
} })
`
  return {
    'app.ts': `export default { project: 'shop', contexts: {
${names.map(name => `  ${name}: { entry: './${name}.ts', owns: [{ method: '*', path: '${paths[name]}/*' }] },`).join('\n')}
} }
`,
    ...Object.fromEntries(names.map(name => [`${name}.ts`, context(name, paths[name])])),
  } as Record<string, string>
}

/** api calls billing through services.fetch; both report their process identity and envelope. */
export function clusterApp(version: string) {
  return {
    'app.ts': `export default { project: 'shop', contexts: {
  api: { entry: './api.ts', owns: [{ method: '*', path: '/api/*' }] },
  billing: { entry: './billing.ts', owns: [{ method: '*', path: '/billing/*' }] },
} }
`,
    'api.ts': `import { defineContext, requestContext } from '{{sdk}}'
export default defineContext({ create: ({ app, services }) => app
  .get('/api/whoami', () => ({ version: '${version}', pid: process.pid, ppid: process.ppid }))
  .get('/api/call', async ({ request }) => {
    const response = await services.fetch('/billing/echo', { request, claims: { sub: 'user-7' } })
    return { pid: process.pid, ppid: process.ppid, front: requestContext(request), back: await response.json(), status: response.status }
  })
  .get('/api/slow', async () => { await Bun.sleep(Number(process.env.SLOW_MS ?? 300)); return 'slow' })
  .ws('/api/live', { message(ws, message) { ws.send('echo:' + message) } }) })
`,
    'billing.ts': `import { defineContext, requestContext } from '{{sdk}}'
export default defineContext({ create: ({ app }) => app
  .get('/billing/echo', ({ request }) => ({ ...requestContext(request), version: '${version}', pid: process.pid })) })
`,
  } as Record<string, string>
}

export const tls = (name: 'server' | 'other') => ({ certFile: join(fixtures, `tls/${name}.crt`), keyFile: join(fixtures, `tls/${name}.key`) })
export const caFile = join(fixtures, 'tls/ca.crt')

/** A free loopback port, so an agent can advertise its address before it listens. */
export function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
  const port = probe.port!
  probe.stop(true)
  return port
}

/** Starts a long-running CLI role and resolves with its first JSON line. */
export async function launchCli(args: string[], env: Record<string, string> = {}, cwd = join(import.meta.dir, '../..')) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../src/cli.ts'), ...args], { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'inherit' })
  const reader = child.stdout.getReader()
  let buffer = ''
  const deadline = Date.now() + 20_000
  while (!buffer.includes('\n')) {
    const next = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => ({ done: true as const, value: undefined }))])
    if (next.done) { child.kill('SIGKILL'); throw new Error(`${args[0]} exited before listening`) }
    buffer += new TextDecoder().decode(next.value)
  }
  reader.releaseLock()
  void child.stdout.pipeTo(new WritableStream()).catch(() => {})
  return { child, info: JSON.parse(buffer.split('\n')[0]!) as { url: string; controlAddress?: string; clusterUrl?: string },
    async stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') { if (child.exitCode === null && child.signalCode === null) child.kill(signal); await child.exited } }
}
