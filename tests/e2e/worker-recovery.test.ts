import { expect, test } from 'bun:test'
import { defineApp, monoripper } from '../../src/index'
import { app, change, root, until } from '../helpers/control'

test('dead worker is replaced within a finite restart budget', async () => {
  const runtime = await monoripper.serve({ app, root, initial: { api: { replicas: 2 } }, http: { port: 0 }, recovery: { backoffMs: 20, maxRestarts: 2 } })
  try {
    const dead = runtime.status()[0]!.pid
    process.kill(dead, 'SIGKILL')
    await until(() => runtime.status().length === 2 && runtime.status().every(worker => worker.pid !== dead))
    expect(runtime.getStatus().contexts.find(context => context.name === 'api')?.restarts).toBe(1)
    expect((await fetch(new URL('/api/pid', runtime.url))).status).toBe(200)
  } finally { await runtime.stop() }
})

test('flapping workers stop restarting and expose budget exhaustion', async () => {
  const runtime = await monoripper.serve({ root, app: defineApp({ project: 'flapping', contexts: {
    flapping: { entry: './flapping.ts', owns: [{ method: '*', path: '/flapping/*' }] },
  } }), initial: { flapping: { replicas: 1 } }, http: { port: 0 }, recovery: { maxRestarts: 2, backoffMs: 20 } })
  try {
    await until(() => runtime.getStatus().contexts[0]?.error?.code === 'RESTART_BUDGET_EXHAUSTED')
    expect(runtime.getStatus().contexts[0]?.restarts).toBe(2)
    expect(runtime.status()).toHaveLength(0)
    expect((await fetch(new URL('/flapping/pid', runtime.url))).status).toBe(503)
  } finally { await runtime.stop() }
})

test('scale-down waits for the full response body, not only headers', async () => {
  const runtime = await monoripper.serve({ app, root, initial: { api: { replicas: 1 } }, http: { port: 0 }, lifecycle: { shutdownTimeoutMs: 1000 } })
  try {
    const response = await fetch(new URL('/api/stream', runtime.url))
    const body = response.text()
    const operation = await runtime.setContext(change(runtime, 'api', 0))
    await until(() => runtime.getStatus().contexts.find(context => context.name === 'api')?.readyReplicas === 0)
    expect((await fetch(new URL('/api/pid', runtime.url))).status).toBe(503)
    expect(runtime.getOperation(operation.id).phase).toBe('applying')
    expect(await body).toBe('firstlast')
    expect((await runtime.waitOperation(operation.id)).phase).toBe('succeeded')
  } finally { await runtime.stop() }
})

test('runtime shutdown preserves an active finite response body', async () => {
  const runtime = await monoripper.serve({ app, root, initial: { api: { replicas: 1 } }, http: { port: 0 }, lifecycle: { shutdownTimeoutMs: 1000 } })
  const response = await fetch(new URL('/api/stream', runtime.url))
  const body = response.text()
  const stopping = runtime.stop()
  expect(await body).toBe('firstlast')
  await stopping
})

test('drain deadline kills a stuck body but never re-enables a disabled context', async () => {
  const runtime = await monoripper.serve({ app, root, initial: { api: { replicas: 1 } }, http: { port: 0 }, lifecycle: { shutdownTimeoutMs: 100, requestTimeoutMs: 1000 } })
  try {
    const response = await fetch(new URL('/api/hang', runtime.url))
    const body = response.text().catch(() => 'aborted')
    const operation = await runtime.setContext(change(runtime, 'api', 0))
    const result = await runtime.waitOperation(operation.id)
    expect(result.phase).toBe('failed')
    expect(result.error?.code).toBe('SHUTDOWN_TIMEOUT')
    expect(runtime.getStatus().contexts.find(context => context.name === 'api')?.desiredReplicas).toBe(0)
    expect(runtime.status()).toHaveLength(0)
    await body
  } finally { await runtime.stop() }
})
