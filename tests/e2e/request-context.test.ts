import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { defineApp, monoripper } from '../../src/index'

const root = join(import.meta.dir, '../fixtures/services')
const app = defineApp({ project: 'services', contexts: {
  front: { entry: './front.ts', owns: [{ method: 'GET', path: '/front/*' }] },
  back: { entry: './back.ts', owns: [{ method: 'GET', path: '/back/*' }] },
} })

test('services.fetch carries trace, remaining deadline, caller and allowed claims; clients cannot forge the envelope', async () => {
  const runtime = await monoripper.serve({ app, root, initial: { front: { replicas: 1 }, back: { replicas: 1 } }, http: { port: 0 },
    lifecycle: { requestTimeoutMs: 5000 }, services: { claims: ['sub'] } })
  try {
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736'
    const started = Date.now()
    const call = await fetch(new URL('/front/call', runtime.url), { headers: { traceparent: `00-${trace}-00f067aa0ba902b7-01` } }).then(r => r.json())
    expect(call.status).toBe(200)
    expect(call.front).toMatchObject({ traceId: trace, claims: {} })
    expect(call.front.caller).toBeUndefined()
    expect(call.front.deadline).toBeLessThanOrEqual(started + 5000 + 50)
    expect(call.back).toMatchObject({ traceId: trace, caller: 'front', claims: { sub: 'user-1' }, query: '?from=front', leaked: [] })
    expect(call.back.requestId).not.toBe(call.front.requestId)
    expect(call.back.deadline).toBeLessThanOrEqual(call.front.deadline + 20)

    const forged = await fetch(new URL('/back/echo', runtime.url), { headers: {
      'x-monoripper-trace-id': 'f'.repeat(32), 'x-monoripper-caller': 'front', 'x-monoripper-claims': '{"sub":"admin"}',
      'x-monoripper-deadline-ms': '99999999', 'x-monoripper-token': 'x', traceparent: '00-' + '0'.repeat(32) + '-00f067aa0ba902b7-01' } }).then(r => r.json())
    expect(forged.traceId).not.toBe('f'.repeat(32))
    expect(forged.traceId).not.toBe('0'.repeat(32))
    expect(forged.caller).toBeUndefined()
    expect(forged.claims).toEqual({})
    expect(forged.deadline).toBeLessThanOrEqual(Date.now() + 5000)
    expect(await fetch(new URL('/front/missing', runtime.url)).then(r => r.json())).toBe(404)
    expect(await fetch(new URL('/front/forge', runtime.url)).then(r => r.json())).toBe(401)
  } finally { await runtime.stop() }
})
