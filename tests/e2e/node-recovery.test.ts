import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectControl, publishRelease, startRegistry, type ControlClient, type Registry } from '../../src/index'
import { buildRelease, caFile, clusterApp, freePort, launchCli, tls, token } from '../helpers/releases'
import { until } from '../helpers/control'

const names = { read: 'RECOVERY_REGISTRY_READ', write: 'RECOVERY_REGISTRY_WRITE', control: 'RECOVERY_CONTROL_TOKEN', cluster: 'RECOVERY_CLUSTER_TOKEN' }
const secrets = { read: token(), write: token(), control: token(), cluster: token() }
const registryPort = freePort()
let directory: string, registry: Registry
const digests: Record<string, string> = {}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const startStore = () => startRegistry({ dataDir: join(directory, 'registry'), http: { port: registryPort }, projects: { shop: { readTokenEnv: names.read, writeTokenEnv: names.write } } })

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'monoripper-recovery-'))
  for (const [key, name] of Object.entries(names)) process.env[name] = secrets[key as keyof typeof secrets]
  registry = await startStore()
  for (const version of ['v1', 'v2']) {
    const built = await buildRelease(clusterApp(version))
    await publishRelease({ url: registry.url.href, token: secrets.write }, new Uint8Array(await readFile(built.file)))
    digests[version] = built.digest
  }
})
afterAll(async () => {
  await registry?.stop()
  for (const name of Object.values(names)) delete process.env[name]
  await rm(directory, { recursive: true, force: true })
})

test('e03s02: heartbeat loss, partition reconnect, registry outage, capacity limits and controller restart', async () => {
  const clusterPort = freePort()
  const controllerConfig = join(directory, 'controller.config.ts')
  await writeFile(controllerConfig, `export default ${JSON.stringify({ release: `shop@${digests.v1}`, registry: { url: registry.url.href, tokenEnv: names.read },
    dataDir: join(directory, 'controller'), initial: { api: { replicas: 1 } }, http: { port: 0 }, capacity: { maxReplicas: 1 },
    control: { port: 0, tokenEnv: names.control }, lifecycle: { shutdownTimeoutMs: 2000 },
    cluster: { port: clusterPort, tls: tls('server'), caFile, tokenEnv: names.cluster, heartbeatTimeoutMs: 800 } })}`)
  const agent = async (id: string) => {
    const port = freePort()
    const config = join(directory, `${id}.config.ts`)
    await writeFile(config, `export default ${JSON.stringify({ id, project: 'shop', controller: { url: `https://127.0.0.1:${clusterPort}/`, tokenEnv: names.cluster, caFile },
      listen: { port, tls: tls('server') }, advertise: `https://127.0.0.1:${port}/`, registry: { url: registry.url.href, tokenEnv: names.read },
      dataDir: join(directory, id), heartbeatMs: 100, capacity: { maxReplicas: 2 } })}`)
    return launchCli(['node', '--config', config])
  }
  let controller = await launchCli(['serve', '--config', controllerConfig])
  let client: ControlClient = await connectControl({ address: controller.info.controlAddress!, token: secrets.control, project: 'shop' })
  const b = await agent('node-b'), c = await agent('node-c')
  const api = async () => (await client.getStatus()).contexts.find(context => context.name === 'api')!
  const scale = async (replicas: number) => client.waitOperation((await client.setContext({ context: 'api', replicas, requestId: crypto.randomUUID(),
    expectedRevision: (await client.getStatus()).revision })).id, 20_000)
  const deploy = async (release: string) => client.waitOperation((await client.setContext({ context: 'api', release, requestId: crypto.randomUUID(),
    expectedRevision: (await client.getStatus()).revision })).id, 30_000)
  const version = async () => (await fetch(new URL('/api/whoami', controller.info.url)).then(r => r.json())).version
  try {
    await until(async () => (await client.getStatus()).nodes?.filter(node => node.healthy).length === 3, 10_000)
    expect(await scale(2)).toMatchObject({ phase: 'succeeded' })
    const onB = (await client.getStatus()).workers.find(worker => worker.node === 'node-b')!.pid

    // Heartbeat loss: node-b leaves routing and its replica is replaced on node-c. The paused agent's replica is still alive:
    // during a partition a context can briefly run more processes than desired, so singleton jobs need an external lock.
    b.child.kill('SIGSTOP')
    await until(async () => (await client.getStatus()).nodes?.find(node => node.id === 'node-b')?.healthy === false, 5000)
    await until(async () => (await client.getStatus()).workers.some(worker => worker.node === 'node-c' && worker.ready), 10_000)
    expect((await api()).readyReplicas).toBe(2)
    expect(alive(onB)).toBe(true)
    // Reconnect: the agent reports a replica this controller already replaced, and is told to stop it.
    b.child.kill('SIGCONT')
    await until(async () => (await client.getStatus()).nodes?.find(node => node.id === 'node-b')?.healthy === true, 5000)
    await until(() => !alive(onB), 10_000)
    expect((await client.getStatus()).workers.filter(worker => worker.context === 'api').map(worker => worker.node).sort()).toEqual(['local', 'node-c'])

    // Registry outage: a digest nobody cached cannot start, so the update fails before its switch and v1 keeps serving.
    await registry.stop()
    expect(await deploy(digests.v2!)).toMatchObject({ phase: 'failed' })
    expect(await version()).toBe('v1')
    registry = await startStore()
    expect(await deploy(digests.v2!)).toMatchObject({ phase: 'succeeded' })
    expect(await version()).toBe('v2')

    // Capacity is bounded by connected nodes: 1 local + 2 + 2.
    expect(await scale(20)).toMatchObject({ phase: 'failed', error: { code: 'CAPACITY_EXCEEDED' } })
    expect((await api()).desiredReplicas).toBe(2)

    // Controller crash: agents keep their replicas, but the new controller does not know them and stops them,
    // then places the desired replicas again as the nodes reconnect.
    const remote = (await client.getStatus()).workers.filter(worker => worker.node !== 'local').map(worker => worker.pid)
    expect(remote.length).toBeGreaterThan(0)
    client.close()
    await controller.stop('SIGKILL')
    expect(remote.every(alive)).toBe(true)
    controller = await launchCli(['serve', '--config', controllerConfig])
    client = await connectControl({ address: controller.info.controlAddress!, token: secrets.control, project: 'shop' })
    await until(async () => (await api()).readyReplicas === 2, 15_000)
    await until(() => remote.every(pid => !alive(pid)), 10_000)
    expect(await version()).toBe('v2')
  } finally {
    client.close()
    b.child.kill('SIGCONT')
    await controller.stop()
    await Promise.all([b.stop(), c.stop()])
  }
}, 120_000)
