import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monoripper } from '../../src/index'
import { app, change, root } from '../helpers/control'

test('accepted state is durable, replay idempotent, revision guarded and restored instead of initial', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-control-'))
  const options = { app, root, dataDir: directory, initial: { api: { replicas: 1 } }, http: { port: 0 } }
  let runtime = await monoripper.serve(options)
  try {
    const input = change(runtime, 'api', 3)
    const operation = await runtime.setContext(input)
    const persisted = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
    expect(persisted.desired.api).toBe(3)
    expect(persisted.operations.some((op: { id: string }) => op.id === operation.id)).toBe(true)
    expect((await runtime.setContext(input)).id).toBe(operation.id)
    expect((await runtime.waitOperation(operation.id)).phase).toBe('succeeded')
    expect(runtime.status().filter(worker => worker.context === 'api' && worker.ready)).toHaveLength(3)
    await expect(runtime.setContext({ ...input, requestId: 'stale' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(runtime.setContext({ ...input, replicas: 2 })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    const pids = runtime.status().map(worker => worker.pid)
    await runtime.stop()
    runtime = await monoripper.serve({ ...options, initial: {} })
    expect(runtime.status()).toHaveLength(3)
    expect(runtime.status().some(worker => pids.includes(worker.pid))).toBe(false)
    expect((await runtime.setContext(input)).id).toBe(operation.id)
    expect(runtime.getStatus().contexts.find(context => context.name === 'api')?.desiredReplicas).toBe(3)
  } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }) }
})

test('failed growth rolls desired count back without leaking private startup errors', async () => {
  const runtime = await monoripper.serve({ app, root, initial: { api: { replicas: 1 } }, http: { port: 0 } })
  try {
    const operation = await runtime.setContext(change(runtime, 'bad', 1))
    const result = await runtime.waitOperation(operation.id)
    expect(result.phase).toBe('failed')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_STARTUP_SECRET')
    expect(runtime.getStatus().contexts.find(context => context.name === 'bad')?.desiredReplicas).toBe(0)
    expect((await fetch(new URL('/api/pid', runtime.url))).status).toBe(200)
  } finally { await runtime.stop() }
})

test('corrupt persistent state refuses startup without replacing data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-corrupt-control-'))
  try {
    await writeFile(join(directory, 'state.json'), '{truncated')
    await expect(monoripper.serve({ app, root, dataDir: directory, initial: {}, http: { port: 0 } })).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(await readFile(join(directory, 'state.json'), 'utf8')).toBe('{truncated')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
