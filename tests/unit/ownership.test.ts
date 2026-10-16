import { expect, test } from 'bun:test'
import { defineApp, monoripper } from '../../src/index'

const context = (method: string, path: string) => ({ entry: './not-loaded.ts', owns: [{ method, path }] })

test('ownership overlap rejects before starting workers', async () => {
  await expect(monoripper.serve({
    app: defineApp({ project: 'ownership', contexts: { a: context('*', '/api/*'), b: context('POST', '/api/login') } }),
    initial: {}, http: { port: 0 },
  })).rejects.toMatchObject({ code: 'OWNERSHIP_CONFLICT' })
})

test('different methods on same path have separate owners; prefix respects path boundary', async () => {
  const runtime = await monoripper.serve({
    app: defineApp({ project: 'ownership', contexts: {
      get: context('GET', '/api/item'), post: context('POST', '/api/item'), user: context('*', '/api/user/*'),
    } }),
    initial: {}, http: { port: 0 },
  })
  try {
    for (const method of ['GET', 'POST']) expect((await fetch(new URL('/api/item', runtime.url), { method })).status).toBe(503)
    expect((await fetch(new URL('/api/item', runtime.url), { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(new URL('/api/user', runtime.url))).status).toBe(503)
    expect((await fetch(new URL('/api/user/nested', runtime.url))).status).toBe(503)
    expect((await fetch(new URL('/api/user-old', runtime.url))).status).toBe(404)
  } finally { await runtime.stop() }
})

test('invalid paths, method rules and numeric config reject explicitly', async () => {
  for (const rule of [context('GET', '/api/:id'), context('get', '/api/x'), context('*', '/api/*/nested')]) {
    await expect(monoripper.serve({ app: defineApp({ project: 'invalid', contexts: { api: rule } }), initial: {} }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  }
  for (const port of [-1, 65536, NaN]) {
    await expect(monoripper.serve({ app: defineApp({ project: 'invalid', contexts: { api: context('*', '/api/*') } }), initial: {}, http: { port } }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  }
})
