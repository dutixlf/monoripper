import { expect, test } from 'bun:test'
import { Elysia, t } from 'elysia'

test('Elysia 1.4 listen preserves plugins, schemas, hooks, route metadata and stop', async () => {
  const events: string[] = []
  const app = new Elysia()
    .onStart(() => { events.push('start') })
    .onStop(() => { events.push('stop') })
    .onBeforeHandle(({ set }) => { set.headers['x-middleware'] = 'yes' })
    .use(Promise.resolve(new Elysia().post('/users/:id', ({ params, body }) => ({
      id: params.id, name: body.name,
    }), { body: t.Object({ name: t.String() }) })))
  await app.modules
  app.listen({ hostname: '127.0.0.1', port: 0 })
  try {
    const response = await fetch(new URL('/users/42', app.server!.url), {
      method: 'POST', body: JSON.stringify({ name: 'test' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(await response.json()).toEqual({ id: '42', name: 'test' })
    expect(response.headers.get('x-middleware')).toBe('yes')
    expect(app.routes.some(route => route.path === '/users/:id' && route.method === 'POST')).toBe(true)
    const invalid = await fetch(new URL('/users/42', app.server!.url), {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    })
    expect(invalid.status).toBe(422)
  } finally {
    await app.stop(true)
  }
  expect(events).toEqual(['start', 'stop'])
})
