import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineApp, monoripper } from '../../src/index'

const root = join(import.meta.dir, '../fixtures/local')

test('only selected context runs in a separate process; resources and hooks close in order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-selected-'))
  const lifecycle = join(directory, 'lifecycle')
  const disabled = join(directory, 'disabled')
  const runtime = await monoripper.serve({
    root,
    app: defineApp({
      project: 'test',
      contexts: {
        user: { entry: './user.ts', owns: [{ method: 'POST', path: '/api/login' }], resources: ['db'] },
        billing: { entry: './billing.ts', owns: [{ method: '*', path: '/api/billing/*' }] },
      },
      resources: { db: { entry: './resource.ts', contexts: ['user'] } },
    }),
    initial: { user: { replicas: 1 } },
    http: { host: '127.0.0.1', port: 0 },
    env: { LIFECYCLE_FILE: lifecycle, DISABLED_MARKER: disabled },
  })
  try {
    const response = await fetch(new URL('/api/login', runtime.url), { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ value: 'resource ready' })
    const second = await fetch(new URL('/api/login', runtime.url), { method: 'POST' }).then(r => r.json())
    expect(second.pid).not.toBe(process.pid)
    expect((await fetch(new URL('/api/billing/invoices', runtime.url))).status).toBe(503)
    expect((await fetch(new URL('/unknown', runtime.url))).status).toBe(404)
    expect(await Bun.file(disabled).exists()).toBe(false)
    expect(await readFile(lifecycle, 'utf8')).toBe('db:start\napp:start\n')
  } finally {
    await runtime.stop()
  }
  try {
    expect(await readFile(lifecycle, 'utf8')).toBe('db:start\napp:start\napp:stop\ncontext:stop\ndb:stop\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const mode of ['create', 'ownership', 'start-hook', 'timeout', 'stop']) {
  test(`worker ${mode} failure cleans resources and does not leave a live process`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'monoripper-failure-'))
    const lifecycle = join(directory, 'lifecycle')
    const pidFile = join(directory, 'pid')
    try {
      const starting = monoripper.serve({
        root,
        app: defineApp({ project: 'failure', contexts: {
          failure: { entry: './failure.ts', owns: [{ method: '*', path: '/failure' }], resources: ['db'] },
        }, resources: { db: { entry: './resource.ts', contexts: ['failure'] } } }),
        initial: { failure: { replicas: 1 } }, http: { port: 0 },
        lifecycle: { startupTimeoutMs: mode === 'timeout' ? 300 : 2000, shutdownTimeoutMs: 1000 },
        env: { FAILURE_MODE: mode, LIFECYCLE_FILE: lifecycle, WORKER_PID_FILE: pidFile },
      })
      if (mode === 'stop') {
        const runtime = await starting
        await expect(runtime.stop()).rejects.toBeInstanceOf(AggregateError)
      } else {
        await expect(starting).rejects.toMatchObject({ code: mode === 'timeout' ? 'STARTUP_TIMEOUT' : 'CONTEXT_START_FAILED' })
      }
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
      const events = await readFile(lifecycle, 'utf8')
      expect(events).toContain('db:start\n')
      expect(events).toContain('db:stop\n')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}
