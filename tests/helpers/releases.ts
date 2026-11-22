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
