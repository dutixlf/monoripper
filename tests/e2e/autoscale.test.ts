import { expect, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectControl, defineApp, monoripper } from '../../src/index'
import { until } from '../helpers/control'

const root = join(import.meta.dir, '../fixtures/autoscale')
const app = defineApp({ project: 'autoscale', contexts: { work: { entry: './slow.ts', owns: [{ method: 'GET', path: '/work/*' }] } } })
const tokenName = 'AUTOSCALE_CONTROL_TOKEN'

test('synthetic load scales replicas up within max; a quiet window scales back to min; manual scaling waits for the policy', async () => {
  process.env[tokenName] = crypto.randomUUID() + crypto.randomUUID()
  const dataDir = await mkdtemp(join(tmpdir(), 'monoripper-autoscale-'))
  const runtime = await monoripper.serve({ app, root, initial: { work: { replicas: 1 } }, http: { port: 0 }, control: { port: 0, tokenEnv: tokenName },
    dataDir,
    autoscale: { intervalMs: 50, upWindowMs: 300, downWindowMs: 1200, cooldownMs: 250, maxStep: 2 } })
  const client = await connectControl({ address: runtime.controlAddress!, token: process.env[tokenName]!, project: app.project })
  const replicas = () => runtime.getStatus().contexts[0]!
  let loading = true
  let peak = 0
  try {
    expect(await client.setAutoscale('work', { min: 1, max: 3, targetInFlight: 2 })).toMatchObject({ context: 'work', policy: { min: 1, max: 3, targetInFlight: 2 } })
    expect(replicas().autoscale).toEqual({ min: 1, max: 3, targetInFlight: 2 })
    await expect(client.setContext({ context: 'work', replicas: 2, requestId: 'manual-while-auto', expectedRevision: (await client.getStatus()).revision }))
      .rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION })
    await expect(client.setAutoscale('work', { min: 3, max: 2, targetInFlight: 1 })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT })

    // About 10 requests in flight for target 2 per replica wants 5 replicas; max caps it at 3.
    const load = Promise.all(Array.from({ length: 10 }, async () => { while (loading) await fetch(new URL('/work/slow?ms=150', runtime.url)).then(r => r.arrayBuffer()) }))
    const watch = setInterval(() => { peak = Math.max(peak, replicas().desiredReplicas, runtime.status().filter(w => w.ready).length) }, 10)
    await until(() => replicas().readyReplicas === 3, 10_000)
    await Bun.sleep(600)
    expect(peak).toBe(3)
    loading = false
    await load
    await until(() => replicas().desiredReplicas === 1 && replicas().readyReplicas === 1, 10_000)
    clearInterval(watch)
    expect(peak).toBe(3)
    const operations = (await client.getStatus()).revision
    expect(operations).toBeGreaterThan(2)

    // Disabling the policy hands the count back to the operator.
    expect(await client.setAutoscale('work')).toMatchObject({ context: 'work' })
    expect(replicas().autoscale).toBeUndefined()
    const manual = await client.setContext({ context: 'work', replicas: 2, requestId: 'manual-after-auto', expectedRevision: (await client.getStatus()).revision })
    expect((await client.waitOperation(manual.id)).phase).toBe('succeeded')
    await Bun.sleep(400)
    expect(replicas().desiredReplicas).toBe(2)
  } finally {
    loading = false
    client.close()
    await runtime.stop()
    delete process.env[tokenName]
    await rm(dataDir, { recursive: true, force: true })
  }
}, 60_000)
