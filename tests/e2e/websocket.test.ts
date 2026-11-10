import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { defineApp, monoripper, type Runtime, type ServeOptions } from '../../src/index'
import exampleApp from '../../examples/websocket/app'

const root = join(import.meta.dir, '../fixtures/local')
const liveApp = defineApp({ project: 'websocket-test', contexts: {
  live: { entry: './live.ts', owns: [{ method: 'GET', path: '/live/*' }] },
} })
const start = (extra: Partial<ServeOptions> = {}) => monoripper.serve({
  root, app: liveApp, initial: { live: { replicas: 1 } },
  http: { port: 0, websocket: { maxMessageBytes: 64 * 1024, maxConnections: 8 } },
  lifecycle: { requestTimeoutMs: 200, shutdownTimeoutMs: 2000 }, recovery: { maxRestarts: 5, backoffMs: 10 }, ...extra,
})

let runtime: Runtime
beforeAll(async () => { runtime = await start({ admin: { port: 0 } }) })
afterAll(async () => { await runtime?.stop() })

type Data = string | ArrayBuffer
function connect(target: Runtime, path: string, init: { protocols?: string[]; headers?: Record<string, string> } = {}) {
  const url = new URL(path, target.url)
  url.protocol = 'ws:'
  const ws = new WebSocket(url, init as never)
  ws.binaryType = 'arraybuffer'
  const queue: Data[] = []
  const waiting: ((data: Data) => void)[] = []
  ws.addEventListener('message', event => { const take = waiting.shift(); if (take) take(event.data); else queue.push(event.data) })
  const closed = new Promise<CloseEvent>(resolve => ws.addEventListener('close', resolve))
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('handshake failed')))
  })
  opened.catch(() => {})
  const next = () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<Data>(resolve => waiting.push(resolve))
  return { ws, opened, closed, next }
}

/** Raw handshake so tests can read refused upgrade statuses, which the WebSocket API hides. */
async function handshake(target: Runtime, path: string, headers: Record<string, string> = {}, method = 'GET') {
  let text = ''
  const socket = await Bun.connect({ hostname: '127.0.0.1', port: Number(target.url.port), socket: { data(_, chunk) { text += chunk.toString('latin1') } } })
  const fields = { Host: target.url.host, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', ...headers }
  socket.write(`${method} ${path} HTTP/1.1\r\n${Object.entries(fields).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`)
  const deadline = performance.now() + 3000
  const complete = () => {
    const end = text.indexOf('\r\n\r\n')
    if (end < 0) return false
    const length = Number(/content-length: (\d+)/i.exec(text.slice(0, end))?.[1] ?? 0)
    return text.startsWith('HTTP/1.1 101') || text.length >= end + 4 + length
  }
  while (!complete() && performance.now() < deadline) await Bun.sleep(5)
  socket.terminate()
  const end = text.indexOf('\r\n\r\n')
  return { status: Number(text.slice(9, 12)), head: text.slice(0, end).toLowerCase(), body: text.slice(end + 4) }
}

/** Reads raw server frames: Bun's WebSocket client reports a received 1001 as 1000. */
async function rawClient(target: Runtime, path: string, headers = '') {
  let buffer = Buffer.alloc(0)
  let upgraded = false
  const texts: string[] = []
  let code!: (value: number) => void
  const closeCode = new Promise<number>(resolve => { code = resolve })
  const socket = await Bun.connect({ hostname: '127.0.0.1', port: Number(target.url.port), socket: {
    data(_, chunk) {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        upgraded = true
        buffer = buffer.subarray(end + 4)
      }
      while (buffer.length >= 2) {
        const short = buffer[1]! & 0x7f
        const offset = short === 126 ? 4 : 2
        const length = short === 126 ? buffer.readUInt16BE(2) : short
        if (buffer.length < offset + length) return
        const payload = buffer.subarray(offset, offset + length)
        if ((buffer[0]! & 0x0f) === 8) code(payload.readUInt16BE(0))
        else if ((buffer[0]! & 0x0f) === 1) texts.push(payload.toString())
        buffer = buffer.subarray(offset + length)
      }
    },
    close() { code(1006) },
  } })
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${target.url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${headers}\r\n`)
  for (let attempt = 0; attempt < 200 && !texts.length; attempt++) await Bun.sleep(10)
  return { first: texts[0], closeCode, end: () => socket.terminate() }
}

test('text and binary echo through the gateway and outlive the request timeout', async () => {
  const client = connect(runtime, '/live/echo')
  await client.opened
  expect(await client.next()).toBe('ready') // Sent by the replica in open(), before the client saw 101.
  client.ws.send('hello')
  expect(await client.next()).toBe('hello')
  const bytes = Uint8Array.from({ length: 300 }, (_, index) => (index * 7) % 256)
  client.ws.send(bytes)
  expect(new Uint8Array(await client.next() as ArrayBuffer)).toEqual(bytes)
  await Bun.sleep(500) // Longer than lifecycle.requestTimeoutMs.
  client.ws.send('still open')
  expect(await client.next()).toBe('still open')
  client.ws.close(4002, 'bye')
  expect((await client.closed).code).toBe(4002)
  await Bun.sleep(50)
  expect(await fetch(new URL('/live/last-close', runtime.url)).then(r => r.json())).toEqual({ code: 4002, reason: 'bye' })
})

test('upstream close code and reason reach the client', async () => {
  const client = connect(runtime, '/live/echo')
  expect(await client.next()).toBe('ready')
  client.ws.send('close')
  const event = await client.closed
  expect([event.code, event.reason]).toEqual([4001, 'done'])
})

test('a burst of large binary messages arrives complete and in order', async () => {
  const client = connect(runtime, '/live/echo')
  expect(await client.next()).toBe('ready')
  client.ws.send('flood:256:60000')
  for (let index = 0; index < 256; index++) {
    const message = new Uint8Array(await client.next() as ArrayBuffer)
    expect(message.length).toBe(60000)
    expect(message[0]).toBe(index % 256)
  }
  expect(await client.next()).toBe('flooded')
  client.ws.close()
})

test('messages above http.websocket.maxMessageBytes close with 1009 in either direction', async () => {
  const sender = connect(runtime, '/live/echo')
  expect(await sender.next()).toBe('ready')
  sender.ws.send('y'.repeat(70 * 1024))
  expect((await sender.closed).code).toBe(1009)
  const receiver = connect(runtime, '/live/echo')
  expect(await receiver.next()).toBe('ready')
  receiver.ws.send('big')
  expect((await receiver.closed).code).toBe(1009)
})

test('path, query, subprotocol, cookies and authorization are forwarded; private and forwarding headers are not', async () => {
  const client = connect(runtime, '/live/info?topic=servers&n=1', {
    protocols: ['chat.v1', 'chat.v2'],
    headers: { cookie: 'sid=abc', authorization: 'Bearer token', 'x-custom': 'kept', 'x-forwarded-for': '203.0.113.9',
      'x-monoripper-spoof': 'evil' },
  })
  await client.opened
  expect(client.ws.protocol).toBe('chat.v2')
  const info = JSON.parse(await client.next() as string)
  expect(info).toEqual({
    query: { topic: 'servers', n: '1' }, path: '/live/info', client: '127.0.0.1', cookie: 'sid=abc', authorization: 'Bearer token',
    custom: 'kept', forwardedFor: null, nominated: null, spoofed: null, extensions: null, protocol: 'chat.v1, chat.v2',
    host: `127.0.0.1:${info.host.split(':')[1]}`,
  })
  expect(info.host).not.toBe(runtime.url.host)
  client.ws.close()
  // Bun's WebSocket client overrides Connection, so nominate a hop-by-hop header over a raw socket.
  const nominated = await rawClient(runtime, '/live/info', 'Connection: Upgrade, x-remove-me\r\nX-Remove-Me: hop\r\n')
  expect(JSON.parse(nominated.first!).nominated).toBeNull()
  nominated.end()
  const raw = await handshake(runtime, '/live/info', { 'Sec-WebSocket-Protocol': 'chat.v2' })
  expect(raw.status).toBe(101)
  expect(raw.head).toContain('set-cookie: session=relayed; path=/; httponly')
  expect(raw.head).toContain('sec-websocket-protocol: chat.v2')
  expect(raw.head).not.toContain('x-monoripper')
})

test('refused upstream handshakes return the upstream status without upgrading', async () => {
  const refused = await handshake(runtime, '/live/private')
  expect(refused.status).toBe(401)
  expect(refused.body).toBe('nope')
  expect(refused.head).not.toContain('upgrade: websocket')
  const missing = await handshake(runtime, '/live/missing')
  expect(missing.status).toBe(404)
  const allowed = connect(runtime, '/live/private', { headers: { authorization: 'Bearer ok' } })
  expect(await allowed.next()).toBe('welcome')
  allowed.ws.close()
})

test('unowned paths, other upgrades and malformed handshakes fail cleanly', async () => {
  expect(await handshake(runtime, '/elsewhere')).toMatchObject({ status: 404, body: '{"error":"NOT_FOUND"}' })
  expect(await handshake(runtime, '/live/echo', { Upgrade: 'h2c' })).toMatchObject({ status: 501, body: '{"error":"UPGRADE_NOT_SUPPORTED"}' })
  expect(await handshake(runtime, '/live/echo', { 'Sec-WebSocket-Version': '8' })).toMatchObject({ status: 400, body: '{"error":"INVALID_UPGRADE"}' })
  expect((await handshake(runtime, '/live/a%2fb')).status).toBe(400)
  await expect(connect(runtime, '/elsewhere').opened).rejects.toThrow()
})

test('max concurrent sockets is enforced with 503', async () => {
  const limited = await start({ http: { port: 0, websocket: { maxConnections: 1 } } })
  try {
    const first = connect(limited, '/live/echo')
    expect(await first.next()).toBe('ready')
    expect(await handshake(limited, '/live/echo')).toMatchObject({ status: 503, body: '{"error":"WEBSOCKET_LIMIT"}' })
    first.ws.close()
    await first.closed
    await Bun.sleep(50)
    const second = connect(limited, '/live/echo')
    expect(await second.next()).toBe('ready')
    second.ws.close()
  } finally { await limited.stop() }
})

test('replica exit closes its sockets with 1012 and recovery serves new sockets', async () => {
  const before = (await fetch(new URL('/live/pid', runtime.url)).then(r => r.json())).pid
  const bystander = connect(runtime, '/live/echo')
  const client = connect(runtime, '/live/echo')
  expect(await bystander.next()).toBe('ready')
  expect(await client.next()).toBe('ready')
  client.ws.send('exit')
  expect((await client.closed).code).toBe(1012)
  expect((await bystander.closed).code).toBe(1012)
  let after = before
  for (let attempt = 0; attempt < 200 && after === before; attempt++) {
    await Bun.sleep(25)
    const response = await fetch(new URL('/live/pid', runtime.url))
    if (response.ok) after = (await response.json()).pid
  }
  expect(after).not.toBe(before)
  const again = connect(runtime, '/live/echo')
  expect(await again.next()).toBe('ready')
  again.ws.close()
})

test('metrics count sockets by context and close reason without paths or clients', async () => {
  const client = connect(runtime, '/live/echo?secret=1')
  expect(await client.next()).toBe('ready')
  const open = await fetch(new URL('/-/metrics', runtime.adminUrl)).then(r => r.text())
  expect(open).toContain('monoripper_websocket_connections{context="live"} 1')
  client.ws.close()
  await client.closed
  await Bun.sleep(50)
  const text = await fetch(new URL('/-/metrics', runtime.adminUrl)).then(r => r.text())
  expect(text).toContain('monoripper_websocket_connections{context="live"} 0')
  expect(text).toMatch(/monoripper_websocket_opened_total\{context="live"\} \d+/)
  expect(text).toMatch(/monoripper_websocket_closed_total\{context="live",reason="client"\} \d+/)
  expect(text).toContain('monoripper_websocket_closed_total{context="live",reason="upstream"} 1')
  expect(text).toContain('monoripper_websocket_closed_total{context="live",reason="upstream_lost"} 2') // Both sockets of the exited replica.
  expect(text).toContain('monoripper_websocket_closed_total{context="live",reason="message_too_big"} 2')
  expect(text).toMatch(/monoripper_http_requests_total\{context="live",method="GET",status="101"\} \d+/)
  expect(text).toContain('monoripper_http_requests_total{context="live",method="GET",status="401"} 1')
  expect(text).not.toContain('secret')
  expect(text).not.toContain('127.0.0.1')
})

test('scale-down and runtime shutdown close sockets with 1001 within the shutdown timeout', async () => {
  const local = await start({ initial: { live: { replicas: 2 } } })
  let stopped = false
  try {
    const clients = [await rawClient(local, '/live/echo'), await rawClient(local, '/live/echo')] // Round-robin: one per replica.
    expect(clients.map(client => client.first)).toEqual(['ready', 'ready'])
    const status = local.getStatus()
    const operation = await local.setContext({ project: status.project, environment: status.environment, context: 'live', replicas: 1,
      requestId: 'scale-down-ws', expectedRevision: status.revision })
    expect((await local.waitOperation(operation.id)).phase).toBe('succeeded')
    const settled = clients.map(client => Promise.race([client.closeCode, Bun.sleep(200).then(() => 'open' as const)]))
    expect((await Promise.all(settled)).sort()).toEqual([1001, 'open'])
    const started = performance.now()
    await local.stop()
    stopped = true
    expect(await Promise.all(clients.map(client => client.closeCode))).toEqual(expect.arrayContaining([1001, 1001]))
    expect(performance.now() - started).toBeLessThan(2000)
    for (const client of clients) client.end()
  } finally { if (!stopped) await local.stop() }
})

test('server-sent events stream through the gateway without buffering', async () => {
  const sse = await start({ lifecycle: { requestTimeoutMs: 5000 } })
  try {
    const response = await fetch(new URL('/live/events', sse.url))
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    const started = performance.now()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toBe('data: one\n\n')
    expect(performance.now() - started).toBeLessThan(300) // The second event is 400 ms behind the first.
    let rest = ''
    for (let next = await reader.read(); !next.done; next = await reader.read()) rest += new TextDecoder().decode(next.value)
    expect(rest).toBe('data: two\n\n')
  } finally { await sse.stop() }
})

test('the WebSocket example broadcasts HTTP-triggered changes to subscribers', async () => {
  const example = await monoripper.serve({ root: join(import.meta.dir, '../../examples/websocket'), app: exampleApp, initial: { live: { replicas: 1 } }, http: { port: 0 } })
  try {
    const client = connect(example, '/api/live/updates')
    expect(JSON.parse(await client.next() as string)).toMatchObject({ type: 'hello' })
    client.ws.send('ping')
    expect(JSON.parse(await client.next() as string)).toEqual({ type: 'pong' })
    const notify = await fetch(new URL('/api/live/notify', example.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"reason":"added"}' })
    expect(await notify.json()).toEqual({ published: true })
    expect(JSON.parse(await client.next() as string)).toEqual({ type: 'servers.changed', reason: 'added' })
    client.ws.close()
  } finally { await example.stop() }
})
