import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineApp, monoripper, type Runtime } from '../../src/index'
import { StateStore } from '../../src/state-store'
import { root } from '../helpers/control'

test('failed replayed growth restores the previous live replica count, not only desired state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-replay-rollback-'))
  const app = defineApp({ project: 'replay-rollback', contexts: {
    limited: { entry: './limited.ts', owns: [{ method: 'GET', path: '/limited/pid' }] },
  } })
  const id = randomUUID()
  let runtime: Runtime | undefined
  try {
    // A valid durable snapshot left by a controller that died during a 1 -> 2 scale.
    const store = await StateStore.open({ project: app.project, environment: 'development',
      contexts: ['limited'], initial: { limited: 1 }, directory })
    try {
      await store.update(next => {
        next.revision = 1
        next.desired.limited = 2
        next.operations.push({ id, requestId: 'replay-limited', context: 'limited', replicas: 2, previousReplicas: 1,
          revision: 1, phase: 'applying', createdAt: 1, updatedAt: 1,
          payloadHash: createHash('sha256').update(JSON.stringify([app.project, 'development', 'limited', 2, 0])).digest('hex') })
      })
    } finally { await store.close() }
    runtime = await monoripper.serve({ app, root, dataDir: directory, initial: {}, http: { port: 0 },
      env: { MONORIPPER_TEST_SLOT: join(directory, 'replica.slot') } })
    expect(runtime.getOperation(id).phase).toBe('failed')
    expect(runtime.getStatus().contexts[0]).toMatchObject({ desiredReplicas: 1, readyReplicas: 1 })
    expect(runtime.getStatus().healthy).toBe(true)
    expect((await fetch(new URL('/limited/pid', runtime.url))).status).toBe(200)
  } finally { await runtime?.stop(); await rm(directory, { recursive: true, force: true }) }
})
