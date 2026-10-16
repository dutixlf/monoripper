import { t } from 'elysia'
import { defineContext } from '../../../src/index'

export default defineContext({
  create({ app }) {
    return app
      .onBeforeHandle(({ set }) => { set.headers['x-middleware'] = 'preserved' })
      .onError(({ code }) => {
        if (code === 'VALIDATION') return Response.json({ error: 'application validation' }, { status: 422 })
      })
      .post('/v1/echo/:id', ({ params, query, body, request }) => ({
        id: params.id, query: query.q, body,
        spoofed: request.headers.get('x-monoripper-client'),
        connectionNominated: request.headers.get('x-remove-me'),
      }), { body: t.Object({ name: t.String() }) })
      .get('/v1/cookies', () => {
        const headers = new Headers()
        headers.append('set-cookie', 'first=one; Path=/; HttpOnly')
        headers.append('set-cookie', 'second=two; Path=/; HttpOnly')
        headers.set('connection', 'x-private')
        headers.set('x-private', 'must not forward')
        headers.set('x-monoripper-token', 'must not forward')
        return new Response('cookies', { status: 201, headers })
      })
      .get('/v1/gzip', () => new Response(Bun.gzipSync('compressed response'), {
        headers: { 'content-encoding': 'gzip' },
      }))
      .get('/v1/redirect', () => new Response(null, { status: 307, headers: { location: '/v1/cookies' } }))
      .get('/v1/error', () => { throw new Error('PRIVATE_STACK_AND_SECRET') })
      .get('/v1/slow', async () => { await Bun.sleep(300); return 'late' })
      .get('/v1/pid', () => ({ pid: process.pid }))
      .get('/v1/test-worker-port', () => ({ port: app.server!.port }))
  },
})
