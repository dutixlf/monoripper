import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MonoripperError, type AppDefinition, type Ownership } from './definitions'
import { createArchive, readArchive, safeArchivePath, sha256Digest, type ArchiveFile, type ArchiveLimits, defaultArchiveLimits } from './archive'
import { validateApp } from './ownership'

/** Bumped when the worker/SDK contract a release relies on changes incompatibly. */
export const RELEASE_ABI = 1
export interface ReleaseCompatibility { bun: string; monoripper: number; elysia: string; platform: string; arch: string }
export interface ReleaseManifest {
  schemaVersion: 1
  project: string
  label?: string
  compatibility: ReleaseCompatibility
  contexts: Record<string, { entry: string; owns: Ownership[]; resources?: string[] }>
  resources?: Record<string, { entry: string; contexts: string[] }>
}
export interface PackResult { project: string; digest: string; label?: string; bytes: number; file: string }

const fail = (code: string, message: string): never => { throw new MonoripperError(code, message) }
export const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const shared = ['elysia', 'monoripper']

export function runtimeVersion(): string {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
}
/** Directory of the Elysia copy this runtime loads; releases share it instead of bundling their own. */
export function elysiaDirectory(): string {
  let directory = dirname(Bun.resolveSync('elysia', fileURLToPath(new URL('.', import.meta.url))))
  while (directory !== dirname(directory)) {
    const file = join(directory, 'package.json')
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === 'elysia') return directory
    directory = dirname(directory)
  }
  return fail('ELYSIA_NOT_FOUND', 'Cannot locate the runtime Elysia package')
}
export function runtimeCompatibility(): ReleaseCompatibility {
  const elysia = JSON.parse(readFileSync(join(elysiaDirectory(), 'package.json'), 'utf8')).version
  return { bun: Bun.version, monoripper: RELEASE_ABI, elysia, platform: process.platform, arch: process.arch }
}
export function assertCompatible(manifest: ReleaseManifest): void {
  const runtime = runtimeCompatibility()
  for (const key of Object.keys(runtime) as (keyof ReleaseCompatibility)[]) {
    if (manifest.compatibility[key] !== runtime[key]) {
      fail('RELEASE_INCOMPATIBLE', `Release was built for ${key} ${manifest.compatibility[key]}; this runtime has ${runtime[key]}`)
    }
  }
}

const allowedRoots = ['entries/', 'chunks/', 'assets/']
export function validateReleaseManifest(manifest: unknown, files?: Set<string>): asserts manifest is ReleaseManifest {
  const value = manifest as ReleaseManifest
  const object = (item: unknown) => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || Object.keys(value).some(key => !['schemaVersion', 'project', 'label', 'compatibility', 'contexts', 'resources'].includes(key))) fail('INVALID_RELEASE', 'Unexpected manifest fields')
  if (value.schemaVersion !== 1) fail('INVALID_RELEASE', 'Unsupported release schemaVersion')
  if (value.label !== undefined && (typeof value.label !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(value.label))) fail('INVALID_RELEASE', 'Invalid release label')
  const compatibility = value.compatibility
  if (!object(compatibility) || Object.keys(compatibility).sort().join() !== 'arch,bun,elysia,monoripper,platform'
    || !Number.isSafeInteger(compatibility.monoripper) || [compatibility.bun, compatibility.elysia, compatibility.platform, compatibility.arch].some(item => typeof item !== 'string' || !/^[\w.+-]{1,64}$/.test(item))) {
    fail('INVALID_RELEASE', 'Invalid release compatibility')
  }
  try { validateApp(value as AppDefinition) } catch (error) { fail('INVALID_RELEASE', error instanceof Error ? error.message : 'Invalid contexts') }
  const entries = [...Object.values(value.contexts).map(context => context.entry), ...Object.values(value.resources ?? {}).map(resource => resource.entry)]
  for (const context of Object.values(value.contexts)) {
    if (Object.keys(context).some(key => !['entry', 'owns', 'resources'].includes(key))) fail('INVALID_RELEASE', 'Unexpected context fields')
  }
  for (const entry of entries) {
    if (!safeArchivePath(entry) || !entry.startsWith('entries/') || !entry.endsWith('.js') || (files && !files.has(entry))) fail('INVALID_RELEASE', `Missing or invalid release entry: ${entry}`)
  }
  for (const file of files ?? []) {
    if (file !== 'manifest.json' && !allowedRoots.some(root => file.startsWith(root))) fail('INVALID_RELEASE', `Unexpected release file: ${file}`)
    if (file.endsWith('.node')) fail('INVALID_RELEASE', 'Native addons are not supported in releases')
  }
}

/** Validates a complete archive in memory; nothing is written. */
export function inspectRelease(bytes: Uint8Array, limits: ArchiveLimits = defaultArchiveLimits): { digest: string; manifest: ReleaseManifest; files: Map<string, ArchiveFile> } {
  const files = readArchive(bytes, limits)
  const raw = files.get('manifest.json')
  if (!raw) return fail('INVALID_RELEASE', 'Release has no manifest.json')
  let manifest: unknown
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.data)) } catch { return fail('INVALID_RELEASE', 'manifest.json is not valid JSON') }
  validateReleaseManifest(manifest, new Set(files.keys()))
  return { digest: sha256Digest(bytes), manifest, files }
}

/** Runtime app definition for an extracted release. Entries become absolute paths inside the read-only release directory. */
export function releaseApp(manifest: ReleaseManifest, directory: string): AppDefinition {
  return {
    project: manifest.project,
    contexts: Object.fromEntries(Object.entries(manifest.contexts).map(([name, context]) => [name, { ...structuredClone(context), entry: join(directory, context.entry) }])),
    resources: Object.fromEntries(Object.entries(manifest.resources ?? {}).map(([name, resource]) => [name, { ...structuredClone(resource), entry: join(directory, resource.entry) }])),
  }
}

/** The repository or installed SDK entry, so relative imports of Monoripper itself stay shared instead of bundled. */
const sdkEntries = new Set([join(packageRoot, 'src/index.ts'), join(packageRoot, 'src/index'), join(packageRoot, 'src'), join(packageRoot, 'dist/index.js'), join(packageRoot, 'dist/index'), join(packageRoot, 'dist')])

async function listFiles(directory: string, base = directory): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...await listFiles(path, base))
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join('/'))
    else fail('PACK_FAILED', `Unexpected build output type: ${entry.name}`)
  }
  return out
}

/**
 * Bundles every context and resource entry with shared chunks into a deterministic archive. Elysia and the Monoripper
 * SDK stay external and are supplied by the runtime; any other import must be bundled or be a Bun/Node builtin.
 */
export async function pack(options: { app: string; out: string; label?: string }): Promise<PackResult> {
  const { loadApp } = await import('./config')
  const { checkApp } = await import('./check')
  const { app, root } = await loadApp(options.app)
  if (options.label !== undefined && !/^[\x21-\x7e]{1,128}$/.test(options.label)) fail('INVALID_ARGUMENT', 'Invalid release label')
  const diagnostics = checkApp(app, { root })
  if (diagnostics.length) fail('PACK_CHECK_FAILED', diagnostics.map(item => `${relative(root, item.file)}:${item.line}:${item.column} ${item.code}: ${item.message}`).join('\n'))
  const sources = new Map<string, string>()
  for (const context of Object.values(app.contexts)) sources.set(resolve(root, context.entry), '')
  for (const resource of Object.values(app.resources ?? {})) sources.set(resolve(root, resource.entry), '')
  const sdkExports = Object.keys(await import('./index')).filter(name => /^[A-Za-z_$][\w$]*$/.test(name))
  const stage = await mkdtemp(join(tmpdir(), 'monoripper-pack-'))
  try {
    const script = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './pack-build.ts' : './pack-build.js', import.meta.url))
    const child = Bun.spawn([process.execPath, script], { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    child.stdin.write(JSON.stringify({ entrypoints: [...sources.keys()], outdir: join(stage, 'out'), external: shared.flatMap(name => [name, `${name}/*`]),
      sdkEntries: [...sdkEntries], sdkExports }))
    await child.stdin.end()
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    let build: { success: boolean; logs: string[]; metafile?: unknown }
    try { build = JSON.parse(output.trim().split('\n').at(-1) ?? '') } catch { return fail('PACK_FAILED', `Bundler failed (${code}): ${errors.trim().slice(0, 2000)}`) }
    if (!build.success) fail('PACK_FAILED', build.logs.join('\n'))
    const cwd = root
    type Imports = { imports: { path: string; external?: boolean }[] }
    const metafile = build.metafile as { inputs: Record<string, Imports>; outputs: Record<string, Imports & { entryPoint?: string }> } | undefined
    if (!metafile) return fail('PACK_FAILED', 'Bun did not produce build metadata')
    for (const [file, input] of Object.entries(metafile.inputs)) {
      for (const item of input.imports) {
        if (!item.external || sdkEntries.has(resolve(cwd, dirname(file), item.path)) || sdkEntries.has(resolve(cwd, dirname(file), (item as { original?: string }).original ?? ''))) continue
        const bare = item.path.startsWith('@') ? item.path.split('/').slice(0, 2).join('/') : item.path.split('/')[0]!
        if (!shared.includes(bare) && !isBuiltin(item.path) && !item.path.startsWith('bun:') && item.path !== 'bun') {
          fail('PACK_UNRESOLVED_IMPORT', `${file} imports ${item.path}, which is neither bundled nor provided by the runtime`)
        }
      }
    }
    // Bun reports entry points relative to the bundler's cwd, the app root.
    const outputs = new Map<string, string>()
    for (const [file, output] of Object.entries(metafile.outputs)) {
      if (output.entryPoint) outputs.set(resolve(cwd, output.entryPoint), file.replace(/^\.\//, ''))
    }
    const entryFor = (source: string) => outputs.get(source) ?? fail('PACK_FAILED', `No build output for ${relative(root, source)}`)
    const manifest: ReleaseManifest = {
      schemaVersion: 1, project: app.project, ...(options.label ? { label: options.label } : {}), compatibility: runtimeCompatibility(),
      contexts: Object.fromEntries(Object.entries(app.contexts).map(([name, context]) => [name, {
        entry: entryFor(resolve(root, context.entry)), owns: structuredClone(context.owns), ...(context.resources ? { resources: [...context.resources] } : {}),
      }])),
      ...(app.resources ? { resources: Object.fromEntries(Object.entries(app.resources).map(([name, resource]) => [name, { entry: entryFor(resolve(root, resource.entry)), contexts: [...resource.contexts] }])) } : {}),
    }
    const files: ArchiveFile[] = []
    for (const path of await listFiles(join(stage, 'out'))) files.push({ path, data: new Uint8Array(await readFile(join(stage, 'out', path))) })
    files.push({ path: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n') })
    validateReleaseManifest(manifest, new Set(files.map(file => file.path)))
    const archive = createArchive(files)
    const out = resolve(options.out)
    const temporary = `${out}.${crypto.randomUUID()}.tmp`
    try { await writeFile(temporary, archive, { mode: 0o644 }); await rename(temporary, out) } finally { await rm(temporary, { force: true }) }
    return { project: app.project, digest: sha256Digest(archive), ...(options.label ? { label: options.label } : {}), bytes: archive.length, file: out }
  } finally { await rm(stage, { recursive: true, force: true }) }
}
