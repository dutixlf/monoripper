import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectControl, monoripper, publishRelease, startRegistry, type Registry } from '../../src/index'
import { buildRelease, caFile, clusterApp, freePort, launchCli, tls, token } from '../helpers/releases'
import { until } from '../helpers/control'

const names = { read: 'NODES_REGISTRY_READ', write: 'NODES_REGISTRY_WRITE', control: 'NODES_CONTROL_TOKEN', cluster: 'NODES_CLUSTER_TOKEN' }
const secrets = { read: token(), write: token(), control: token(), cluster: token() }
let directory: string, registry: Registry, digest: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'monoripper-nodes-'))
  for (const [key, name] of Object.entries(names)) process.env[name] = secrets[key as keyof typeof secrets]
  registry = await startRegistry({ dataDir: join(directory, 'registry'), projects: { shop: { readTokenEnv: names.read, writeTokenEnv: names.write } } })
  const built = await buildRelease(clusterApp('v1'))
  await publishRelease({ url: registry.url.href, token: secrets.write }, new Uint8Array(await readFile(built.file)))
  digest = built.digest
})
afterAll(async () => {
  await registry?.stop()
  for (const name of Object.values(names)) delete process.env[name]
  await rm(directory, { recursive: true, force: true })
})

async function agent(id: string, clusterUrl: string, options: { cert?: 'server' | 'other'; advertisePort?: number; maxReplicas?: number } = {}) {
  const port = freePort()
  const config = join(directory, `${id}.config.ts`)
  await writeFile(config, `export default ${JSON.stringify({ id, project: 'shop', controller: { url: clusterUrl, tokenEnv: names.cluster, caFile },
    listen: { port, tls: tls(options.cert ?? 'server') }, advertise: `https://127.0.0.1:${options.advertisePort ?? port}/`,
    registry: { url: registry.url.href, tokenEnv: names.read }, dataDir: join(directory, id), heartbeatMs: 100, capacity: { maxReplicas: options.maxReplicas ?? 4 } })}`)
  return { ...await launchCli(['node', '--config', config]), port }
}

test('e03s01: a node agent serves replicas behind the one gateway with request context, TLS and credentials', async () => {
  const runtime = await monoripper.serve({ release: `shop@${digest}`, registry: { url: registry.url.href, tokenEnv: names.read }, root: directory,
    dataDir: join(directory, 'controller'), initial: { api: { replicas: 1 }, billing: { replicas: 1 } }, http: { port: 0 },
    capacity: { maxReplicas: 2 }, control: { port: 0, tokenEnv: names.control }, services: { claims: ['sub'] }, admin: { port: 0 },
    cluster: { tls: tls('server'), caFile, tokenEnv: names.cluster, heartbeatTimeoutMs: 2000 } })
  const client = await connectControl({ address: runtime.controlAddress!, token: secrets.control, project: 'shop' })
  const b = await agent('node-b', runtime.clusterUrl!.href)
  const untrusted = await agent('node-untrusted', runtime.clusterUrl!.href, { cert: 'other' })
  const unreachable = await agent('node-unreachable', runtime.clusterUrl!.href, { advertisePort: freePort() })
  try {
    await until(async () => (await client.getStatus()).nodes?.filter(node => node.healthy).length === 4, 10_000)
    // Fill the local node so the next replica must go to an agent.
    const scale = async (context: string, replicas: number) => client.waitOperation((await client.setContext({ context, replicas, requestId: crypto.randomUUID(),
      expectedRevision: (await client.getStatus()).revision })).id, 20_000)
    // Ties go by node id: node-b is tried first and succeeds.
    expect(await scale('api', 2)).toMatchObject({ phase: 'succeeded' })
    let status = await client.getStatus()
    expect(status.workers.filter(worker => worker.context === 'api').map(worker => worker.node).sort()).toEqual(['local', 'node-b'])
    const remotePid = status.workers.find(worker => worker.node === 'node-b')!.pid

    // A request through the gateway reaches the agent's worker; services.fetch from it crosses back to billing.
    const seen = new Map<number, { ppid: number; back: Record<string, unknown>; front: Record<string, unknown> }>()
    const trace = 'a'.repeat(31) + 'b'
    await until(async () => {
      const body = await fetch(new URL('/api/call', runtime.url), { headers: { traceparent: `00-${trace}-00f067aa0ba902b7-01`, 'x-monoripper-caller': 'forged', 'x-monoripper-worker': 'forged' } }).then(r => r.json())
      seen.set(body.pid, body)
      return seen.size === 2
    })
    const remote = seen.get(remotePid)!
    expect(remote.ppid).toBe(b.child.pid) // The replica is a child of the agent process, not of the gateway.
    expect(remote.front).toMatchObject({ traceId: trace, claims: {} })
    expect(remote.front.caller).toBeUndefined()
    expect(remote.back).toMatchObject({ traceId: trace, caller: 'api', claims: { sub: 'user-7' }, version: 'v1' })
    expect(Number(remote.back.deadline)).toBeLessThanOrEqual(Number(remote.front.deadline) + 50)

    // The admin endpoint scrapes the remote replica through its agent.
    const metrics = await fetch(new URL('/-/metrics', runtime.adminUrl!)).then(r => r.text())
    expect(metrics).toContain(`app_up{context="api",worker="${remotePid}"} 1`)
    expect(metrics).not.toContain('monoripper_worker_scrape_errors_total{context="api"}')

    // WebSockets relay through both hops.
    const sockets = await Promise.all([0, 1].map(() => new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(new URL('/api/live', runtime.url.href.replace('http', 'ws')))
      ws.onopen = () => ws.send('hi'); ws.onmessage = event => { resolve(String(event.data)); ws.close() }; ws.onerror = () => reject(new Error('ws'))
    })))
    expect(sockets).toEqual(['echo:hi', 'echo:hi'])

    // Agents and the cluster endpoint require the cluster credential over verified TLS.
    const agentUrl = `https://127.0.0.1:${b.port}/`
    for (const headers of [{}, { 'x-monoripper-cluster-token': 'wrong-' + secrets.cluster.slice(6) }] as Record<string, string>[]) {
      expect((await fetch(new URL('/v1/workers', agentUrl), { headers, tls: { ca: await readFile(caFile, 'utf8') } })).status).toBe(401)
      expect((await fetch(new URL('/api/whoami', agentUrl), { headers: { ...headers, 'x-monoripper-worker': 'x' }, tls: { ca: await readFile(caFile, 'utf8') } })).status).toBe(401)
    }
    await expect(fetch(new URL('/v1/workers', agentUrl), { headers: { 'x-monoripper-cluster-token': secrets.cluster } })).rejects.toThrow() // Unknown CA.
    expect((await fetch(new URL('/v1/nodes/heartbeat', runtime.clusterUrl!), { method: 'POST', body: '{}', tls: { ca: await readFile(caFile, 'utf8') } })).status).toBe(401)

    // Billing fills the last local slot; then only the untrusted and unreachable agents have room, and both fail.
    expect(await scale('billing', 0)).toMatchObject({ phase: 'succeeded' })
    expect(await scale('billing', 1)).toMatchObject({ phase: 'succeeded' })
    status = await client.getStatus()
    const failed = await scale('api', 6)
    expect(failed.phase).toBe('failed')
    expect(['NODE_UNREACHABLE', 'CAPACITY_EXCEEDED']).toContain(failed.error!.code)
    status = await client.getStatus()
    expect(status.workers.filter(worker => worker.node === 'node-untrusted' || worker.node === 'node-unreachable')).toEqual([])
    expect(status.contexts.find(context => context.name === 'api')).toMatchObject({ desiredReplicas: 2, readyReplicas: 2 })
  } finally {
    client.close()
    await runtime.stop()
    await Promise.all([b.stop(), untrusted.stop(), unreachable.stop()])
  }
}, 90_000)
