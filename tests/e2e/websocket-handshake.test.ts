import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { connectWebSocket } from '../../src/websocket'

/** A raw TCP "replica" that answers each handshake with `respond(request, accept)`. */
const replicas: { stop(closeActiveConnections?: boolean): void }[] = []
function replica(respond: (request: string, accept: string) => string | undefined) {
  const server = Bun.listen<{ request: string }>({ hostname: '127.0.0.1', port: 0, socket: {
    open(socket) { socket.data = { request: '' } },
    data(socket, chunk) {
      socket.data.request += chunk.toString('latin1')
      if (!socket.data.request.includes('\r\n\r\n')) return
      const key = /sec-websocket-key: (.+)\r\n/i.exec(socket.data.request)![1]!
      const reply = respond(socket.data.request, createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'))
      if (reply !== undefined) socket.write(reply)
      if (reply?.includes('Connection: close')) socket.end()
    },
  } })
  replicas.push(server)
  return server.port
}
afterAll(() => { for (const server of replicas) server.stop(true) })

const connect = (port: number, headers: Record<string, string> = {}, timeoutMs = 2000) => connectWebSocket({
  port, target: '/live?x=1', headers: new Headers(headers), signal: AbortSignal.timeout(timeoutMs),
  maxMessageBytes: 1024, maxBufferedBytes: 4096, closeTimeoutMs: 100,
})
const upgrade = (accept: string, extra = '') => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${extra}\r\n`

test('the replica receives the target, a fresh key and only forwarded headers', async () => {
  let seen = ''
  const port = replica((request, accept) => { seen = request; return upgrade(accept) })
  const result = await connect(port, { cookie: 'a=1', 'sec-websocket-protocol': 'v1' })
  expect('relay' in result).toBe(true)
  if ('relay' in result) result.relay.abort()
  expect(seen).toStartWith('GET /live?x=1 HTTP/1.1\r\nHost: 127.0.0.1:')
  expect(seen).toContain('cookie: a=1\r\n')
  expect(seen).toContain('sec-websocket-protocol: v1\r\n')
  expect(seen.match(/sec-websocket-key/gi)).toHaveLength(1)
})

test('refusals keep status, headers and bounded bodies', async () => {
  const sized = await connect(replica(() => 'HTTP/1.1 403 Forbidden\r\nContent-Length: 4\r\nX-Reason: auth\r\n\r\nnope'))
  expect(sized).toMatchObject({ status: 403, body: new TextEncoder().encode('nope') })
  expect(!('relay' in sized) && sized.headers.get('x-reason')).toBe('auth')
  const chunked = await connect(replica(() => 'HTTP/1.1 400 Bad Request\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nnope\r\n0\r\n\r\n'))
  expect(chunked).toMatchObject({ status: 400, body: null })
  const huge = await connect(replica(() => `HTTP/1.1 413 Too Large\r\nContent-Length: ${70 * 1024}\r\n\r\n${'x'.repeat(70 * 1024)}`))
  expect(huge).toMatchObject({ status: 413, body: null })
  const truncated = await connect(replica(() => 'HTTP/1.1 401 Unauthorized\r\nContent-Length: 10\r\nConnection: close\r\n\r\nshort'))
  expect(truncated).toMatchObject({ status: 401 })
})

test('invalid upgrades from the replica are transport errors', async () => {
  const invalid: [string, (accept: string) => string][] = [
    ['wrong accept', () => upgrade('AAAAAAAAAAAAAAAAAAAAAAAAAAA=')],
    ['unrequested extension', accept => upgrade(accept, 'Sec-WebSocket-Extensions: permessage-deflate\r\n')],
    ['subprotocol not offered', accept => upgrade(accept, 'Sec-WebSocket-Protocol: other\r\n')],
    ['malformed status line', () => 'HTTP/1.0 101 Switching\r\n\r\n'],
    ['malformed header', () => 'HTTP/1.1 101 Switching\r\nno colon here\r\n\r\n'],
    ['oversized head', () => 'HTTP/1.1 101 Switching\r\n' + 'X-Pad: '.padEnd(17 * 1024, 'x')],
  ]
  for (const [name, reply] of invalid) {
    const port = replica((_, accept) => reply(accept))
    await expect(connect(port, { 'sec-websocket-protocol': 'v1' }), name).rejects.toThrow()
  }
})

test('a silent replica times out and a closed port fails fast', async () => {
  await expect(connect(replica(() => undefined), {}, 100)).rejects.toThrow('aborted')
  const closed = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = closed.port
  closed.stop(true)
  await expect(connect(port)).rejects.toThrow()
})
