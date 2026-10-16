import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { defineApp, monoripper, type Runtime } from '../../src/index'

let runtime: Runtime
const diagnostics: { context: string; code: string; message: string }[] = []
beforeAll(async () => {
  runtime = await monoripper.serve({
    root: join(import.meta.dir, '../fixtures/local'),
    app: defineApp({ project: 'http-test', contexts: {
      api: { entry: './http-context.ts', owns: [{ method: '*', path: '/v1/*' }] },
    } }),
    initial: { api: { replicas: 2 } }, http: { port: 0, maxRequestBodyBytes: 1024 },
    onDiagnostic: event => diagnostics.push(event),
    lifecycle: { requestTimeoutMs: 100, shutdownTimeoutMs: 1000 },
  })
})
afterAll(async () => { await runtime?.stop() })
const url = (path: string) => new URL(path, runtime.url)

test('proxy preserves body, params, query, schemas and middleware, strips private/hop headers', async () => {
  const response = await fetch(url('/v1/echo/42?q=hello'), {
    method: 'POST', body: JSON.stringify({ name: 'user' }), headers: {
      'content-type': 'application/json', 'x-monoripper-client': 'spoofed',
      connection: 'x-remove-me', 'x-remove-me': 'private',
    },
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('x-middleware')).toBe('preserved')
  expect(await response.json()).toEqual({ id: '42', query: 'hello', body: { name: 'user' }, spoofed: null, connectionNominated: null })
  const invalid = await fetch(url('/v1/echo/42'), { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
  expect(invalid.status).toBe(422)
  expect(await invalid.json()).toEqual({ error: 'application validation' })
})

test('cookies, status and redirect are preserved without following the redirect', async () => {
  const response = await fetch(url('/v1/cookies'))
  expect(response.status).toBe(201)
  expect(response.headers.getSetCookie()).toEqual(['first=one; Path=/; HttpOnly', 'second=two; Path=/; HttpOnly'])
  expect(response.headers.get('x-private')).toBeNull()
  expect(response.headers.get('x-monoripper-token')).toBeNull()
  const redirect = await fetch(url('/v1/redirect'), { redirect: 'manual' })
  expect(redirect.status).toBe(307)
  expect(redirect.headers.get('location')).toBe('/v1/cookies')
})

test('compressed bytes and encoding match', async () => {
  const response = await fetch(url('/v1/gzip'), { decompress: false })
  expect(response.headers.get('content-encoding')).toBe('gzip')
  expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer())))).toBe('compressed response')
})

test('unhandled application exceptions do not expose private messages', async () => {
  const response = await fetch(url('/v1/error'))
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain('PRIVATE_STACK_AND_SECRET')
  expect(diagnostics).toContainEqual({ context: 'api', code: 'UNHANDLED_APPLICATION_ERROR', message: 'PRIVATE_STACK_AND_SECRET' })
})

test('ready replicas receive round-robin traffic and timeout does not retry', async () => {
  const pids = []
  for (let i = 0; i < 4; i++) pids.push((await fetch(url('/v1/pid')).then(r => r.json())).pid)
  expect(new Set(pids).size).toBe(2)
  expect(pids[0]).toBe(pids[2])
  const timeout = await fetch(url('/v1/slow'))
  expect(timeout.status).toBe(504)
  expect(await timeout.json()).toEqual({ error: 'DEADLINE_EXCEEDED' })
})

test('worker cannot be called directly without its private credential', async () => {
  const { port } = await fetch(url('/v1/test-worker-port')).then(response => response.json())
  const direct = `http://127.0.0.1:${port}/v1/pid`
  expect((await fetch(direct)).status).toBe(403)
  expect((await fetch(direct, { headers: { 'x-monoripper-token': 'spoofed' } })).status).toBe(403)
})

test('oversized uploads are rejected by the configured HTTP boundary', async () => {
  const response = await fetch(url('/v1/echo/42'), {
    method: 'POST', body: JSON.stringify({ name: 'x'.repeat(2048) }),
    headers: { 'content-type': 'application/json' },
  })
  expect(response.status).toBe(413)
})

test('ambiguous encoded paths are rejected before ownership matching', async () => {
  expect((await fetch(url('/v1/a%2fb'))).status).toBe(400)
  expect((await fetch(url('/v1/a%255cb'))).status).toBe(400)
  expect((await fetch(url('/v1/a%ZZ'))).status).toBe(400)
})
