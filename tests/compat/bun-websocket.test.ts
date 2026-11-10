// Canaries for Bun 1.3.13 WebSocket behaviour that Monoripper works around. When one fails after a Bun
// upgrade, the quirk changed: revisit the workaround named in the test, then update or delete the canary.
import { expect, test } from 'bun:test'

type Server = ReturnType<typeof Bun.serve<object>>
function upgrading(websocket: Bun.WebSocketHandler<object>, headers?: Record<string, string>): Server {
  return Bun.serve<object>({ port: 0, fetch(request, server) { return server.upgrade(request, { data: {}, headers }) ? undefined : new Response('no', { status: 400 }) }, websocket })
}
/** Graceful stop first: see the forced-stop canary below. */
const shutdown = async (server: Server) => { server.stop(false).catch(() => {}); await server.stop(true) }
const open = (server: Server, protocols?: string[]) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`, protocols)
  ws.onopen = () => resolve(ws)
  ws.onerror = () => reject(new Error('handshake failed'))
})

test('canary: graceful server.stop() never settles once a WebSocket was upgraded (runtime.ts stop awaits only stop(true))', async () => {
  const server = upgrading({ message() {} })
  const ws = await open(server)
  const closed = new Promise(resolve => { ws.onclose = resolve })
  ws.close()
  await closed
  const graceful = server.stop(false)
  expect(await Promise.race([graceful.then(() => 'settled'), Bun.sleep(300).then(() => 'pending')])).toBe('pending')
  await server.stop(true)
})

test('canary: forced stop() hangs after a server-initiated close unless a graceful stop() ran first (runtime.ts stop order)', async () => {
  const stopAfterClose = async (gracefulFirst: boolean) => {
    const server = upgrading({ open(ws) { ws.close(1001, 'away') }, message() {} })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
    await new Promise(resolve => { ws.onclose = resolve })
    if (gracefulFirst) server.stop(false).catch(() => {})
    return Promise.race([server.stop(true).then(() => 'stopped'), Bun.sleep(300).then(() => 'hung')])
  }
  expect(await stopAfterClose(true)).toBe('stopped')
  expect(await stopAfterClose(false)).toBe('hung')
})

test('canary: sending again inside the drain callback misses the next drain (WebSocketRelay.clientDrained defers)', async () => {
  const chunk = new Uint8Array(256 * 1024)
  const run = async (defer: boolean) => {
    let sent = 0
    const fill = (ws: Bun.ServerWebSocket<object>) => { while (sent < 100) { sent++; if (ws.sendBinary(chunk) === -1) return } }
    const server = upgrading({ open: fill, drain(ws) { if (defer) setImmediate(() => fill(ws)); else fill(ws) }, message() {} })
    let received = 0
    const ws = await open(server)
    ws.onmessage = () => { received++ }
    for (let attempt = 0; attempt < 100 && received < 100; attempt++) await Bun.sleep(10)
    ws.close()
    await shutdown(server)
    return received
  }
  expect(await run(true)).toBe(100)
  expect(await run(false)).toBeLessThan(100)
})

test('canary: oversized client messages drop the connection with 1006, not 1009 (relay enforces maxMessageBytes itself)', async () => {
  let observed: [number, string] | undefined
  const server = upgrading({ maxPayloadLength: 16, message() {}, close(_, code, reason) { observed = [code, reason] } })
  const client = await open(server)
  const closed = new Promise<CloseEvent>(resolve => { client.onclose = resolve })
  client.send('x'.repeat(64))
  expect((await closed).code).toBe(1006)
  expect(observed).toEqual([1006, 'Received too big message'])
  await shutdown(server)
})

test('canary: Bun clients report a received 1001 as 1000 (tests read raw close frames)', async () => {
  const server = upgrading({ open(ws) { ws.close(1001, 'away') }, message() {} })
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
  const event = await new Promise<CloseEvent>(resolve => { ws.onclose = resolve })
  expect([event.code, event.reason]).toEqual([1000, 'away'])
  await shutdown(server)
})

test('canary: without a chosen subprotocol Bun selects the first offered one (documented gateway behaviour)', async () => {
  const server = upgrading({ message() {} })
  const ws = await open(server, ['first', 'second'])
  expect(ws.protocol).toBe('first')
  ws.close()
  await shutdown(server)
})
