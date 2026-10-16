import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineApp, monoripper } from '../../src/index'
import { until } from '../helpers/control'

const root = join(import.meta.dir, '../fixtures/local')
const app = defineApp({ project: 'cancel-startup', contexts: {
  failure: { entry: './failure.ts', owns: [{ method: 'GET', path: '/failure' }], resources: ['db'] },
}, resources: { db: { entry: './resource.ts', contexts: ['failure'] } } })

test('an already cancelled startup does not create persistent controller state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-cancelled-'))
  const cancel = new AbortController()
  cancel.abort()
  try {
    await expect(monoripper.serve({ app, root, initial: {}, dataDir: join(directory, 'state'),
      startupSignal: cancel.signal, http: { port: 0 } })).rejects.toMatchObject({ code: 'SHUTTING_DOWN' })
    expect(await Bun.file(join(directory, 'state/state.lock')).exists()).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const failedCleanup of [false, true]) {
  test(`startup cancellation closes resources, releases the writer and exposes cleanup failure=${failedCleanup}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'monoripper-cancel-'))
    const cancel = new AbortController()
    const pidFile = join(directory, 'pid'), lifecycle = join(directory, 'lifecycle')
    const options = { app, root, initial: { failure: { replicas: 1 } }, dataDir: join(directory, 'state'), http: { port: 0 },
      lifecycle: { startupTimeoutMs: 10_000, shutdownTimeoutMs: 1000 },
      env: { FAILURE_MODE: 'timeout', FAILURE_STOP: failedCleanup ? '1' : '0', WORKER_PID_FILE: pidFile, LIFECYCLE_FILE: lifecycle } }
    const starting = monoripper.serve({ ...options, startupSignal: cancel.signal })
    try {
      await until(async () => await Bun.file(pidFile).exists() && Number(await Bun.file(pidFile).text()) > 1)
      cancel.abort()
      await expect(starting).rejects.toMatchObject({ code: failedCleanup ? 'CONTEXT_STOP_FAILED' : 'SHUTTING_DOWN' })
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
      expect(await readFile(lifecycle, 'utf8')).toBe('db:start\ncontext:stop\ndb:stop\n')
      const restored = await monoripper.serve({ ...options, initial: {}, env: { ...options.env, FAILURE_MODE: '', FAILURE_STOP: '0' } })
      try { expect(restored.status()).toHaveLength(1) } finally { await restored.stop() }
    } finally { cancel.abort(); await starting.catch(() => {}); await rm(directory, { recursive: true, force: true }) }
  })
}

test('CLI SIGTERM during startup closes workers before exiting successfully', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-cli-startup-'))
  const lifecycle = join(directory, 'lifecycle'), pidFile = join(directory, 'pid')
  await writeFile(join(directory, 'app.ts'), `export default ${JSON.stringify({ ...app,
    contexts: { failure: { ...app.contexts.failure, entry: join(root, 'failure.ts') } },
    resources: { db: { entry: join(root, 'resource.ts'), contexts: ['failure'] } },
  })}`)
  const config = join(directory, 'config.ts')
  await writeFile(config, `export default ${JSON.stringify({ app: './app.ts', initial: { failure: { replicas: 1 } },
    http: { port: 0 }, lifecycle: { startupTimeoutMs: 10_000, shutdownTimeoutMs: 1000 },
    env: { FAILURE_MODE: 'timeout', LIFECYCLE_FILE: lifecycle, WORKER_PID_FILE: pidFile } })}`)
  const child = Bun.spawn([process.execPath, 'src/cli.ts', 'serve', '--config', config], {
    cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe',
  })
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
  try {
    await until(async () => await Bun.file(pidFile).exists() && Number(await Bun.file(pidFile).text()) > 1)
    child.kill('SIGTERM')
    expect(await child.exited).toBe(0)
    expect(await output).not.toContain('"event":"listening"')
    expect(await errors).toBe('')
    expect(await readFile(lifecycle, 'utf8')).toBe('db:start\ncontext:stop\ndb:stop\n')
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
    await rm(directory, { recursive: true, force: true })
  }
})
