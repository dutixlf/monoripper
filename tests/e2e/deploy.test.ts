import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectControl, monoripper, publishRelease, startRegistry, type ControlClient, type Registry, type Runtime } from '../../src/index'
import { buildRelease, token, versionedApp } from '../helpers/releases'
import { app as sourceApp, root as sourceRoot, until } from '../helpers/control'

const projectRoot = join(import.meta.dir, '../..')
const names = { read: 'DEPLOY_REGISTRY_READ', write: 'DEPLOY_REGISTRY_WRITE', control: 'DEPLOY_CONTROL_TOKEN' }
const secrets = { read: token(), write: token(), control: token() }
let directory: string, registry: Registry
const releases: Record<string, string> = {}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'monoripper-deploy-'))
  for (const [key, name] of Object.entries(names)) process.env[name] = secrets[key as keyof typeof secrets]
  registry = await startRegistry({ dataDir: join(directory, 'registry'), projects: { shop: { readTokenEnv: names.read, writeTokenEnv: names.write } } })
  const variants = {
    v1: versionedApp('v1'), v2: versionedApp('v2'), v3: versionedApp('v3', { broken: ['billing'] }),
    v4: versionedApp('v4', { paths: { api: '/billing', billing: '/payments' } }), v5: versionedApp('v5', { extra: true }),
  }
  for (const [name, files] of Object.entries(variants)) {
    const built = await buildRelease(files, name)
    await publishRelease({ url: registry.url.href, token: secrets.write }, new Uint8Array(await readFile(built.file)))
    releases[name] = built.digest
  }
})
afterAll(async () => {
  await registry?.stop()
  for (const name of Object.values(names)) delete process.env[name]
  await rm(directory, { recursive: true, force: true })
})

const serveRelease = (dataDir: string, extra: Partial<Parameters<typeof monoripper.serve>[0]> = {}) => monoripper.serve({
  release: `shop@${releases.v1}`, registry: { url: registry.url.href, tokenEnv: names.read }, dataDir, root: directory,
  initial: { api: { replicas: 2 }, billing: { replicas: 1 } }, http: { port: 0 }, control: { port: 0, tokenEnv: names.control },
  lifecycle: { shutdownTimeoutMs: 8000 }, env: { SLOW_MS: '3000' }, ...extra,
} as Parameters<typeof monoripper.serve>[0])
const version = async (runtime: Runtime | URL | string, path = '/api/version') => {
  const response = await fetch(new URL(path, typeof runtime === 'object' && 'url' in runtime ? runtime.url : runtime))
  return response.status === 200 ? (await response.json()).version : response.status
}
async function deploy(client: ControlClient, context: string, release: string, replicas?: number) {
  const operation = await client.setContext({ context, release, requestId: crypto.randomUUID(), expectedRevision: (await client.getStatus()).revision, ...(replicas !== undefined ? { replicas } : {}) })
  return client.waitOperation(operation.id, 20_000)
}
function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, 'src/cli.ts', ...args], { cwd: projectRoot, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
  return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }))
}

test('deploy switches atomically, finishes old requests on v1, keeps v2 after a broken v3, and rolls back by digest', async () => {
  const runtime = await serveRelease(join(directory, 'main'))
  const client = await connectControl({ address: runtime.controlAddress!, token: secrets.control, project: 'shop' })
  try {
    expect(await version(runtime)).toBe('v1')
    const slow = await fetch(new URL('/api/slow', runtime.url))
    const slowBody = slow.text()
    let slowDone = false
    void slowBody.then(() => { slowDone = true })
    const accepted = await client.setContext({ context: 'api', release: releases.v2!, requestId: 'deploy-api-v2', expectedRevision: (await client.getStatus()).revision })
    expect(accepted).toMatchObject({ release: releases.v2, replicas: 2, phase: 'accepted' })
    await until(async () => await version(runtime) === 'v2', 10_000)
    expect(slowDone).toBe(false) // New requests reach v2 while the old request is still running on v1.
    await until(async () => (await client.getOperation(accepted.id)).step === 'draining')
    expect(await slowBody).toBe('v1:done')
    const done = await client.waitOperation(accepted.id, 10_000)
    expect(done).toMatchObject({ phase: 'succeeded', release: releases.v2 })
    expect(done.warning).toBeUndefined()
    let status = await client.getStatus()
    expect(status.contexts.find(c => c.name === 'api')).toMatchObject({ release: releases.v2, servingRelease: releases.v2, lastGoodRelease: releases.v2, readyReplicas: 2 })
    expect(status.workers.filter(w => w.context === 'api').every(w => w.release === releases.v2)).toBe(true)

    // CLI: one operation per context. Broken billing in v3 fails before its switch; api moves to v3.
    const partial = await cli(['deploy', '--controller', runtime.controlAddress!, '--project', 'shop', '--token-env', names.control,
      '--release', releases.v3!, '--contexts', 'api,billing', '--request-id', 'v3-rollout', '--wait'])
    expect(partial.code).toBe(1)
    const result = JSON.parse(partial.stdout)
    expect(result.operations.map((op: { context: string; phase: string }) => [op.context, op.phase])).toEqual([['api', 'succeeded'], ['billing', 'failed']])
    expect(result.operations[1].error.code).toBe('CONTEXT_START_FAILED')
    expect(partial.stderr).toContain('v3-rollout:billing')
    expect(await version(runtime)).toBe('v3')
    expect(await version(runtime, '/billing/version')).toBe('v1')
    status = await client.getStatus()
    expect(status.contexts.find(c => c.name === 'billing')).toMatchObject({ release: releases.v1, readyReplicas: 1 })
    // Retrying the same CLI request IDs returns the same operations instead of deploying again.
    const retry = JSON.parse((await cli(['deploy', '--controller', runtime.controlAddress!, '--project', 'shop', '--token-env', names.control,
      '--release', releases.v3!, '--contexts', 'api', '--request-id', 'v3-rollout'])).stdout)
    expect(retry.operations[0].id).toBe(result.operations[0].id)

    // Rollback is an ordinary deployment of a retained digest.
    expect(await deploy(client, 'api', releases.v1!)).toMatchObject({ phase: 'succeeded' })
    expect(await version(runtime)).toBe('v1')

    // v4 moves api onto billing's serving paths: rejected before any switch.
    const conflict = await deploy(client, 'api', releases.v4!)
    expect(conflict).toMatchObject({ phase: 'failed', error: { code: 'OWNERSHIP_CONFLICT' } })
    expect(await version(runtime)).toBe('v1')
    expect((await client.getStatus()).contexts.find(c => c.name === 'api')).toMatchObject({ release: releases.v1, servingRelease: releases.v1 })

    // A release may add a context; deploying it creates the context with one replica by default.
    expect(await deploy(client, 'extra', releases.v5!)).toMatchObject({ phase: 'succeeded', replicas: 1 })
    expect(await version(runtime, '/extra/version')).toBe('v5')
    // A context missing from the target release fails and does not appear in desired state.
    expect(await deploy(client, 'ghost', releases.v2!)).toMatchObject({ phase: 'failed', error: { code: 'RELEASE_CONTEXT_MISSING' } })
    expect((await client.getStatus()).contexts.map(c => c.name)).toEqual(['api', 'billing', 'extra'])
  } finally { client.close(); await runtime.stop() }

  // Restart: desired releases are durable state; the bootstrap applies to new state only.
  const restarted = await serveRelease(join(directory, 'main'), { release: `shop@${releases.v2}` })
  try {
    expect(await version(restarted)).toBe('v1')
    expect(await version(restarted, '/extra/version')).toBe('v5')
  } finally { await restarted.stop() }
}, 90_000)

test('deployments need temporary old+new capacity and a release-mode runtime', async () => {
  const runtime = await serveRelease(join(directory, 'small'), { capacity: { maxReplicas: 3 }, initial: { api: { replicas: 2 } } })
  const client = await connectControl({ address: runtime.controlAddress!, token: secrets.control, project: 'shop' })
  try {
    const failed = await deploy(client, 'api', releases.v2!)
    expect(failed).toMatchObject({ phase: 'failed', error: { code: 'CAPACITY_EXCEEDED' } })
    expect(await version(runtime)).toBe('v1')
    expect((await client.getStatus()).contexts.find(c => c.name === 'api')).toMatchObject({ release: releases.v1, desiredReplicas: 2, readyReplicas: 2 })
    expect(await deploy(client, 'api', releases.v2!, 1)).toMatchObject({ phase: 'succeeded' }) // 2 old + 1 new fits.
    expect(runtime.status().filter(worker => worker.context === 'api')).toHaveLength(1)
  } finally { client.close(); await runtime.stop() }
  const source = await monoripper.serve({ app: sourceApp, root: sourceRoot, initial: {}, http: { port: 0 } })
  try {
    await expect(source.setContext({ project: sourceApp.project, environment: 'development', context: 'api', requestId: 'source-deploy', expectedRevision: 0, release: releases.v1 }))
      .rejects.toMatchObject({ code: 'RELEASES_DISABLED' })
  } finally { await source.stop() }
}, 60_000)

async function launch(config: string, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, 'src/cli.ts', 'serve', '--config', config], { cwd: projectRoot, env: { ...process.env, ...extraEnv }, stdout: 'pipe', stderr: 'inherit' })
  const reader = child.stdout.getReader()
  let buffer = ''
  while (!buffer.includes('\n')) {
    const next = await Promise.race([reader.read(), Bun.sleep(15_000).then(() => ({ done: true, value: undefined }))])
    if (next.done) throw new Error('serve exited before listening')
    buffer += new TextDecoder().decode(next.value)
  }
  reader.releaseLock()
  void child.stdout.pipeTo(new WritableStream()).catch(() => {})
  return { child, info: JSON.parse(buffer.split('\n')[0]!) as { url: string; controlAddress: string } }
}

test('a crash between the switch and its persistence recovers from the durable operation', async () => {
  const data = join(directory, 'crash')
  const config = join(directory, 'crash.config.ts')
  await writeFile(config, `export default ${JSON.stringify({ release: `shop@${releases.v1}`, registry: { url: registry.url.href, tokenEnv: names.read }, dataDir: data,
    initial: { api: { replicas: 1 } }, http: { port: 0 }, control: { port: 0, tokenEnv: names.control }, lifecycle: { shutdownTimeoutMs: 2000 } })}`)
  let server = await launch(config, { MONORIPPER_FAILPOINT: 'deploy-after-switch' })
  let client = await connectControl({ address: server.info.controlAddress, token: secrets.control, project: 'shop' })
  try {
    const accepted = await client.setContext({ context: 'api', release: releases.v2!, requestId: 'crash-deploy', expectedRevision: 0 })
    expect(await server.child.exited).not.toBe(0)
    client.close()
    const state = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'))
    expect(state.operations[0]).toMatchObject({ id: accepted.id, phase: 'applying', step: 'switching' })
    expect(state.serving.api).toBe(releases.v1) // The switch to v2 was never persisted.
    expect(state.releases.api).toBe(releases.v2)
    server = await launch(config)
    client = await connectControl({ address: server.info.controlAddress, token: secrets.control, project: 'shop' })
    expect((await client.waitOperation(accepted.id, 10_000)).phase).toBe('succeeded')
    expect(await version(server.info.url)).toBe('v2')
    expect((await client.getStatus()).contexts[0]).toMatchObject({ servingRelease: releases.v2, lastGoodRelease: releases.v2 })
  } finally {
    client.close()
    if (server.child.exitCode === null) server.child.kill('SIGTERM')
    await server.child.exited
  }
}, 60_000)

test('e02 gate: CLI pack → publish → deploy moves one digest from staging to production without rebuild', async () => {
  const source = await mkdtemp(join(tmpdir(), 'monoripper-pipeline-'))
  const work = join(directory, 'pipeline')
  try {
    for (const [path, content] of Object.entries(versionedApp('pipeline'))) await writeFile(join(source, path), content.replaceAll('{{sdk}}', join(projectRoot, 'src/index.ts')))
    await Bun.$`mkdir -p ${join(source, 'node_modules')} ${work} && ln -s ${join(projectRoot, 'node_modules/elysia')} ${join(source, 'node_modules/elysia')}`.quiet()
    const packed = await cli(['pack', '--app', join(source, 'app.ts'), '--out', join(work, 'release.tar.gz'), '--label', '2.0.0'])
    expect(packed.code).toBe(0)
    const digest = JSON.parse(packed.stdout).digest
    const published = await cli(['publish', join(work, 'release.tar.gz'), '--registry', registry.url.href, '--token-env', names.write, '--output', join(work, 'release.json')])
    expect(published.code).toBe(0)
    expect(JSON.parse(await readFile(join(work, 'release.json'), 'utf8'))).toEqual({ schemaVersion: 1, project: 'shop', digest, label: '2.0.0', bytes: expect.any(Number) })
    await rm(source, { recursive: true, force: true })
    const environments = ['staging', 'production'] as const
    const runtimes = await Promise.all(environments.map(environment => serveRelease(join(directory, environment), { environment, initial: { api: { replicas: 1 } } })))
    try {
      for (const [index, environment] of environments.entries()) {
        const runtime = runtimes[index]!
        const rollout = await cli(['deploy', '--controller', runtime.controlAddress!, '--project', 'shop', '--environment', environment, '--token-env', names.control,
          '--release', join(work, 'release.json'), '--contexts', 'api'])
        expect(rollout.code).toBe(0)
        const id = JSON.parse(rollout.stdout).operations[0].id
        // Waiting resumes by operation ID, as after a lost CI connection.
        const waited = await cli(['operation', '--controller', runtime.controlAddress!, '--project', 'shop', '--environment', environment, '--token-env', names.control, '--id', id, '--wait'])
        expect(JSON.parse(waited.stdout)).toMatchObject({ phase: 'succeeded', release: digest })
        expect(await version(runtime)).toBe('pipeline')
        expect(runtime.getStatus().contexts[0]).toMatchObject({ servingRelease: digest })
      }
    } finally { await Promise.all(runtimes.map(runtime => runtime.stop())) }
    // A runtime can bootstrap from the same release.json.
    const bootstrapped = await serveRelease(join(directory, 'from-json'), { release: join(work, 'release.json'), initial: { api: { replicas: 1 } } })
    try { expect(await version(bootstrapped)).toBe('pipeline') } finally { await bootstrapped.stop() }
  } finally { await rm(source, { recursive: true, force: true }) }
}, 90_000)
