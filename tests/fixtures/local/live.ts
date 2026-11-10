import { Elysia, status } from 'elysia'
import { defineContext, requestClientAddress } from '../../../src/index'

let lastClose: { code: number; reason: string } | null = null
const header = (headers: Record<string, string | undefined>, name: string) => headers[name] ?? null

// A typed plugin keeps Elysia's .ws() inference; the context mounts it on the runtime-owned app.
const live = new Elysia()
  .ws('/live/echo', {
    open(ws) { ws.send('ready') },
    message(ws, message) {
      if (message === 'close') ws.close(4001, 'done')
      else if (message === 'exit') process.exit(3)
      else if (message === 'big') ws.send('x'.repeat(70 * 1024))
      else if (typeof message === 'string' && message.startsWith('flood:')) {
        const [, count, size] = message.split(':').map(Number)
        for (let index = 0; index < count!; index++) ws.send(Buffer.alloc(size!, index % 256))
        ws.send('flooded')
      } else ws.send(message as string | Buffer)
    },
    close(_, code, reason) { lastClose = { code, reason } },
  })
  .ws('/live/info', {
    upgrade({ request, set }) {
      const offered = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(item => item.trim())
      if (offered.includes('chat.v2')) set.headers['sec-websocket-protocol'] = 'chat.v2'
      set.headers['set-cookie'] = 'session=relayed; Path=/; HttpOnly'
    },
    open(ws) {
      const { headers, request, query } = ws.data
      ws.send(JSON.stringify({
        query, path: new URL(request.url).pathname, client: requestClientAddress(request),
        cookie: header(headers, 'cookie'), authorization: header(headers, 'authorization'), custom: header(headers, 'x-custom'),
        forwardedFor: header(headers, 'x-forwarded-for'), nominated: header(headers, 'x-remove-me'),
        spoofed: header(headers, 'x-monoripper-spoof'), extensions: header(headers, 'sec-websocket-extensions'),
        protocol: header(headers, 'sec-websocket-protocol'), host: header(headers, 'host'),
      }))
    },
  })
  .ws('/live/private', {
    beforeHandle({ headers }) { if (headers.authorization !== 'Bearer ok') return status(401, 'nope') },
    open(ws) { ws.send('welcome') },
  })
  .ws('/live/deny', { open(ws) { ws.close(4401, 'denied') } })
  .get('/live/last-close', () => lastClose)
  .get('/live/pid', () => ({ pid: process.pid }))
  .get('/live/events', () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode('data: one\n\n'))
      await Bun.sleep(400)
      controller.enqueue(new TextEncoder().encode('data: two\n\n'))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } }))

export default defineContext({ create: ({ app }) => app.use(live) })
