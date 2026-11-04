import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineApp, monoripper } from '../../src/index'

const root = join(import.meta.dir, '../fixtures/local')
const observedApp = (extra: Record<string, { entry: string; owns: { method: string; path: string }[] }> = {}) => defineApp({
  project: 'observed',
  contexts: { observed: { entry: './observed.ts', owns: [{ method: 'GET', path: '/observed/*' }] }, ...extra },
})

test('background context runs lifecycle hooks without ingress and its signal aborts on stop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-background-'))
  const lifecycle = join(directory, 'lifecycle')
  const runtime = await monoripper.serve({
    root, app: observedApp({ background: { entry: './background.ts', owns: [] } }),
    initial: { background: { replicas: 1 } }, http: { port: 0 }, env: { LIFECYCLE_FILE: lifecycle },
  })
  try {
    expect(runtime.status()).toMatchObject([{ context: 'background', ready: true }])
    expect((await fetch(new URL('/', runtime.url))).status).toBe(404)
    await Bun.sleep(100)
    expect(await readFile(lifecycle, 'utf8')).toContain('tick\n')
  } finally { await runtime.stop() }
  try {
    const lines = (await readFile(lifecycle, 'utf8')).trim().split('\n')
    expect(lines.indexOf('aborted')).toBeGreaterThan(-1)
    expect(lines.indexOf('stopped')).toBeGreaterThan(lines.indexOf('aborted'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('background context cannot register routes', async () => {
  await expect(monoripper.serve({
    root, app: defineApp({ project: 'background', contexts: { observed: { entry: './observed.ts', owns: [] } } }),
    initial: { observed: { replicas: 1 } }, http: { port: 0 },
  })).rejects.toMatchObject({ code: 'CONTEXT_START_FAILED' })
})

test('admin listener reports health, readiness and merged metrics without paths or client data', async () => {
  const runtime = await monoripper.serve({
    root, app: observedApp(), initial: { observed: { replicas: 2 } },
    http: { port: 0 }, admin: { port: 0 }, recovery: { maxRestarts: 0 },
  })
  try {
    const admin = runtime.adminUrl!
    expect(admin.hostname).toBe('127.0.0.1')
    expect(await fetch(new URL('/-/healthz', admin)).then(r => r.status)).toBe(200)
    expect(await fetch(new URL('/-/readyz', admin)).then(r => r.json())).toEqual({ status: 'ready' })
    expect((await fetch(new URL('/-/metrics', runtime.url))).status).toBe(404) // Not on the public gateway.
    expect((await fetch(new URL('/-/metrics', admin), { method: 'POST' })).status).toBe(405)

    for (let index = 0; index < 3; index++) expect((await fetch(new URL('/observed/headers?secret=1', runtime.url))).status).toBe(200)
    expect((await fetch(new URL('/unknown/path', runtime.url))).status).toBe(404)
    const text = await fetch(new URL('/-/metrics', admin)).then(r => r.text())
    expect(text).toContain('monoripper_http_requests_total{context="observed",method="GET",status="200"} 3')
    expect(text).toContain('monoripper_gateway_errors_total{context="",code="NOT_FOUND"} 2')
    expect(text).toContain('monoripper_context_replicas_ready{context="observed"} 2')
    expect(text).toContain('monoripper_http_request_duration_seconds_count{context="observed"} 3')
    expect(text.match(/^# TYPE app_served_total counter$/gm)).toHaveLength(1)
    const served = [...text.matchAll(/^app_served_total\{context="observed",worker="(\d+)",kind="headers"\} (\d+)$/gm)]
    expect(served).toHaveLength(2)
    expect(served.reduce((sum, match) => sum + Number(match[2]), 0)).toBe(3)
    expect(text).not.toContain('/observed')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('127.0.0.1')

    await fetch(new URL('/observed/crash', runtime.url)).catch(() => undefined)
    await fetch(new URL('/observed/crash', runtime.url)).catch(() => undefined)
    const deadline = Date.now() + 3000
    while (runtime.status().length && Date.now() < deadline) await Bun.sleep(20)
    const notReady = await fetch(new URL('/-/readyz', admin))
    expect(notReady.status).toBe(503)
    expect(await notReady.json()).toEqual({ status: 'not_ready', contexts: ['observed'] })
    expect(await fetch(new URL('/-/healthz', admin)).then(r => r.status)).toBe(200)
  } finally { await runtime.stop() }
  await expect(fetch(new URL('/-/healthz', runtime.adminUrl!))).rejects.toThrow()
})

test('worker exposition cannot claim runtime metric names', async () => {
  const runtime = await monoripper.serve({
    root, app: observedApp(), initial: { observed: { replicas: 1 } },
    http: { port: 0 }, admin: { port: 0 }, env: { METRICS_MODE: 'reserved' },
  })
  try {
    const text = await fetch(new URL('/-/metrics', runtime.adminUrl!)).then(r => r.text())
    expect(text).toContain('monoripper_worker_scrape_errors_total{context="observed"} 1')
    expect(text.match(/^monoripper_ready /gm)).toHaveLength(1)
  } finally { await runtime.stop() }
})

test('forwarding headers are stripped from untrusted peers and resolved from trusted proxies', async () => {
  const spoof = { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.8', 'x-forwarded-proto': 'https', 'x-monoripper-client-ip': '198.51.100.1' }
  const untrusted = await monoripper.serve({ root, app: observedApp(), initial: { observed: { replicas: 1 } }, http: { port: 0 } })
  try {
    expect(await fetch(new URL('/observed/headers', untrusted.url), { headers: spoof }).then(r => r.json()))
      .toEqual({ client: '127.0.0.1', forwardedFor: null, realIp: null, proto: null })
  } finally { await untrusted.stop() }

  const trusted = await monoripper.serve({
    root, app: observedApp(), initial: { observed: { replicas: 1 } },
    http: { port: 0, trustedProxies: ['127.0.0.0/8', '10.0.0.0/8'] },
  })
  try {
    const chain = { ...spoof, 'x-forwarded-for': '198.51.100.7, 203.0.113.9, 10.1.2.3' }
    expect(await fetch(new URL('/observed/headers', trusted.url), { headers: chain }).then(r => r.json()))
      .toEqual({ client: '203.0.113.9', forwardedFor: chain['x-forwarded-for'], realIp: '203.0.113.8', proto: 'https' })
    expect(await fetch(new URL('/observed/headers', trusted.url), { headers: { 'x-real-ip': '203.0.113.8' } }).then(r => r.json()))
      .toMatchObject({ client: '203.0.113.8' })
  } finally { await trusted.stop() }
  await expect(monoripper.serve({ root, app: observedApp(), initial: {}, http: { trustedProxies: ['10.0.0.0/33'] } }))
    .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
})

test('CLI json logging frames runtime events and worker output with context and worker', async () => {
  const child = Bun.spawn([process.execPath, 'src/cli.ts', 'serve', '--config', 'tests/fixtures/local/observed.config.ts'], {
    cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe',
  })
  const lines: Record<string, unknown>[] = []
  let listening: { url: string; adminUrl: string } | undefined
  const reader = (async () => {
    let buffer = ''
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const parsed = JSON.parse(line)
        lines.push(parsed)
        if (parsed.event === 'listening') listening = parsed
      }
    }
  })()
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
  try {
    while (!listening && child.exitCode === null) await Bun.sleep(10)
    expect(listening?.adminUrl).toStartWith('http://127.0.0.1:')
    expect((await fetch(new URL('/observed/headers', listening!.url))).status).toBe(200)
    const until = Date.now() + 2000
    while (lines.filter(line => line.context === 'observed' && line.worker).length < 3 && Date.now() < until) await Bun.sleep(10)
    expect(lines).toContainEqual(expect.objectContaining({ component: 'monoripper', event: 'worker_ready', context: 'observed' }))
    expect(lines).toContainEqual(expect.objectContaining({ level: 30, msg: 'served', context: 'observed' }))
    expect(lines).toContainEqual(expect.objectContaining({ level: 'info', msg: 'plain line', context: 'observed' }))
    child.kill('SIGTERM')
    expect(await child.exited).toBe(0)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
    await reader
  }
}, 15_000)
