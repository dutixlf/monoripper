import { describe, expect, test } from 'bun:test'
import { FrameReader, WebSocketRelay, type ReaderEvent, type RelayClient, type UpstreamSocket } from '../../src/websocket'

const text = (value: string) => new TextEncoder().encode(value)
const bytes = (...values: number[]) => Uint8Array.from(values)
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length } return out }

/** An unmasked server frame; options produce the malformed variants a replica could send. */
function frame(opcode: number, payload: Uint8Array = new Uint8Array(0), options: { fin?: boolean; rsv?: number; masked?: boolean; declared?: bigint } = {}) {
  const length = options.declared ?? BigInt(payload.length)
  const extended = length < 126n ? 0 : length < 65536n ? 2 : 8
  const head = new Uint8Array(2 + extended + (options.masked ? 4 : 0))
  head[0] = (options.fin === false ? 0 : 0x80) | ((options.rsv ?? 0) << 4) | opcode
  head[1] = (options.masked ? 0x80 : 0) | (extended === 0 ? Number(length) : extended === 2 ? 126 : 127)
  if (extended === 2) new DataView(head.buffer).setUint16(2, Number(length))
  if (extended === 8) new DataView(head.buffer).setBigUint64(2, length)
  return concat(head, payload)
}
const close = (code: number, reason = '') => frame(8, concat(bytes(code >> 8, code & 0xff), text(reason)))

function drain(reader: FrameReader): ReaderEvent[] {
  const events: ReaderEvent[] = []
  for (let event = reader.read(); event; event = reader.read()) events.push(event)
  return events
}
/** Feeds the input whole, byte by byte, and split at every boundary; all must yield the same events. */
function parseEverySplit(input: Uint8Array, max = 1024): ReaderEvent[] {
  const run = (chunks: Uint8Array[]) => {
    const reader = new FrameReader(max)
    const events: ReaderEvent[] = []
    for (const chunk of chunks) { reader.push(chunk); events.push(...drain(reader)) }
    return events
  }
  const whole = run([input])
  expect(run([...input].map(byte => bytes(byte)))).toEqual(whole)
  for (let split = 1; split < input.length; split++) expect(run([input.subarray(0, split), input.subarray(split)])).toEqual(whole)
  return whole
}

describe('FrameReader', () => {
  const big = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251)
  const cases: [string, Uint8Array, ReaderEvent[], number?][] = [
    ['text', frame(1, text('hello')), [{ type: 'message', data: 'hello' }]],
    ['binary with 16-bit length', frame(2, big.subarray(0, 300)), [{ type: 'message', data: big.subarray(0, 300) }]],
    ['binary with 64-bit length', frame(2, big), [{ type: 'message', data: big }], 100_000],
    ['message of exactly the limit', frame(2, big.subarray(0, 1024)), [{ type: 'message', data: big.subarray(0, 1024) }]],
    ['fragments with an interleaved ping', concat(frame(1, text('he'), { fin: false }), frame(9, text('p')), frame(0, text('llo'))),
      [{ type: 'ping', payload: text('p') }, { type: 'message', data: 'hello' }]],
    ['UTF-8 split across fragments', concat(frame(1, bytes(0xe2, 0x82), { fin: false }), frame(0, bytes(0xac))), [{ type: 'message', data: '€' }]],
    ['empty fragments', concat(frame(2, new Uint8Array(0), { fin: false }), frame(0, new Uint8Array(0))), [{ type: 'message', data: new Uint8Array(0) }]],
    ['pong', frame(10, text('x')), [{ type: 'pong' }]],
    ['close with code and reason; later bytes ignored', concat(close(4001, 'done'), frame(1, text('late'))), [{ type: 'close', code: 4001, reason: 'done' }]],
    ['close without payload', frame(8), [{ type: 'close', code: undefined, reason: '' }]],
    ['close with a one-byte payload', frame(8, bytes(3)), [{ type: 'error', code: 1002 }]],
    ['close with reserved code 1005', close(1005), [{ type: 'error', code: 1002 }]],
    ['close with code 999', close(999), [{ type: 'error', code: 1002 }]],
    ['close with invalid UTF-8 reason', frame(8, bytes(0x03, 0xe8, 0xff)), [{ type: 'error', code: 1007 }]],
    ['text with invalid UTF-8', frame(1, bytes(0xc3, 0x28)), [{ type: 'error', code: 1007 }]],
    ['masked server frame', frame(1, text('x'), { masked: true }), [{ type: 'error', code: 1002 }]],
    ['reserved bit', frame(1, text('x'), { rsv: 4 }), [{ type: 'error', code: 1002 }]],
    ['reserved data opcode', frame(3), [{ type: 'error', code: 1002 }]],
    ['reserved control opcode', frame(11), [{ type: 'error', code: 1002 }]],
    ['continuation without a message', frame(0, text('x')), [{ type: 'error', code: 1002 }]],
    ['new message inside a fragmented one', concat(frame(1, text('a'), { fin: false }), frame(1, text('b'))), [{ type: 'error', code: 1002 }]],
    ['fragmented control frame', frame(9, text('x'), { fin: false }), [{ type: 'error', code: 1002 }]],
    ['control frame above 125 bytes', frame(9, new Uint8Array(126)), [{ type: 'error', code: 1002 }]],
    ['single frame above the limit', frame(2, new Uint8Array(1025)), [{ type: 'error', code: 1009 }]],
    ['fragments above the limit', concat(frame(2, new Uint8Array(600), { fin: false }), frame(0, new Uint8Array(600))), [{ type: 'error', code: 1009 }]],
    ['declared 2^63 length', frame(2, new Uint8Array(0), { declared: 1n << 63n }), [{ type: 'error', code: 1009 }]],
  ]
  for (const [name, input, expected, max] of cases) {
    test(name, () => {
      // Splitting a 70 kB frame at every boundary is slow; split smaller inputs exhaustively.
      if (input.length > 4096) {
        const reader = new FrameReader(max ?? 1024)
        reader.push(input)
        expect(drain(reader)).toEqual(expected)
      } else expect(parseEverySplit(input, max)).toEqual(expected)
    })
  }
  test('an oversized frame is rejected from its header, before its payload arrives', () => {
    const reader = new FrameReader(1024)
    reader.push(frame(2, new Uint8Array(0), { declared: 5000n }))
    expect(reader.read()).toEqual({ type: 'error', code: 1009 })
  })
  test('buffered counts unparsed input and incomplete fragments', () => {
    const reader = new FrameReader(1024)
    reader.push(frame(2, new Uint8Array(10), { fin: false }))
    reader.push(frame(0, new Uint8Array(20)).subarray(0, 5))
    expect(drain(reader)).toEqual([])
    expect(reader.buffered).toBe(15)
  })
})

class FakeSocket implements UpstreamSocket {
  frames: { opcode: number; payload: Uint8Array }[] = []
  writable = Number.POSITIVE_INFINITY
  failWrites = false
  ended = false
  terminated = false
  paused = false
  write(data: Uint8Array | string) {
    if (this.failWrites) throw new Error('write failed')
    const chunk = typeof data === 'string' ? text(data) : data
    const written = Math.min(chunk.length, this.writable)
    this.writable -= written
    if (written === chunk.length) this.frames.push(unmask(chunk))
    return written
  }
  end() { this.ended = true }
  terminate() { this.terminated = true }
  pause() { this.paused = true }
  resume() { this.paused = false }
}
function unmask(chunk: Uint8Array) {
  let length = chunk[1]! & 0x7f, offset = 2
  if (length === 126) { length = (chunk[2]! << 8) | chunk[3]!; offset = 4 } else if (length === 127) { length = Number(new DataView(chunk.buffer, chunk.byteOffset + 2).getBigUint64(0)); offset = 10 }
  const mask = chunk.subarray(offset, offset + 4)
  return { opcode: chunk[0]! & 0x0f, payload: chunk.subarray(offset + 4, offset + 4 + length).map((byte, index) => byte ^ mask[index & 3]!) }
}
class FakeClient implements RelayClient {
  sent: (string | Uint8Array)[] = []
  closed?: [number | undefined, string | undefined]
  status = 1
  failSends = false
  sendText(data: string) { if (this.failSends) throw new Error('send failed'); this.sent.push(data); return this.status }
  sendBinary(data: Uint8Array) { this.sent.push(data); return this.status }
  close(code?: number, reason?: string) { this.closed ??= [code, reason] }
  getBufferedAmount() { return 0 }
}
function relay(limits: Partial<{ maxMessageBytes: number; maxBufferedBytes: number; closeTimeoutMs: number }> = {}) {
  const socket = new FakeSocket()
  const client = new FakeClient()
  const relay = new WebSocketRelay(socket, { maxMessageBytes: 1024, maxBufferedBytes: 4096, closeTimeoutMs: 50, ...limits }, new Uint8Array(0))
  const done: string[] = []
  relay.onDone = reason => done.push(reason)
  relay.attach(client)
  return { relay, socket, client, done }
}

describe('WebSocketRelay', () => {
  test('messages pass both ways and pings are answered with masked pongs', () => {
    const { relay: r, socket, client } = relay()
    r.receive(concat(frame(1, text('hi')), frame(9, text('beat')), frame(2, bytes(1, 2))))
    expect(client.sent).toEqual(['hi', bytes(1, 2)])
    r.fromClient('up')
    expect(socket.frames.map(f => [f.opcode, new TextDecoder().decode(f.payload)])).toEqual([[10, 'beat'], [1, 'up']])
  })
  test('an internal error closes only this socket with 1011 and is reported once', () => {
    const { relay: r, socket, client, done } = relay()
    socket.failWrites = true
    expect(() => r.fromClient('boom')).not.toThrow()
    expect(client.closed).toEqual([1011, 'Internal error'])
    expect(socket.terminated).toBe(true)
    expect(done).toEqual(['internal_error'])
    expect(() => { r.fromClient('again'); r.receive(frame(1, text('x'))); r.clientClosed(1000, ''); r.lost(); r.goAway() }).not.toThrow()
    expect(done).toEqual(['internal_error'])
  })
  test('a throwing client send and a throwing onDone are contained', () => {
    const { relay: r, client, done } = relay()
    client.failSends = true
    r.onDone = reason => { done.push(reason); throw new Error('bookkeeping failed') }
    expect(() => r.receive(frame(1, text('x')))).not.toThrow()
    expect(done).toEqual(['internal_error'])
  })
  test('client data the replica cannot accept closes with 1013 above maxBufferedBytes', () => {
    const { relay: r, socket, client } = relay()
    socket.writable = 0
    for (let index = 0; index < 4; index++) r.fromClient(new Uint8Array(1000))
    expect(client.closed).toBeUndefined()
    r.fromClient(new Uint8Array(1000))
    expect(client.closed).toEqual([1013, 'Backpressure'])
    expect(socket.terminated).toBe(true)
  })
  test('a backpressured client pauses the replica; data beyond maxBufferedBytes closes with 1013', () => {
    const { relay: r, socket, client } = relay()
    client.status = -1
    r.receive(frame(2, new Uint8Array(500)))
    expect(socket.paused).toBe(true)
    for (let index = 0; index < 3; index++) r.receive(frame(2, new Uint8Array(1000))) // 3 × 1004 bytes held, under the 4096 cap.
    expect(client.closed).toBeUndefined()
    r.receive(frame(2, new Uint8Array(1100)))
    expect(client.closed).toEqual([1013, 'Backpressure'])
  })
  test('a drained client resumes delivery of held messages in order', async () => {
    const { relay: r, socket, client } = relay()
    client.status = -1
    r.receive(concat(frame(1, text('a')), frame(1, text('b'))))
    expect(client.sent).toEqual(['a'])
    client.status = 1
    r.clientDrained()
    await new Promise(resolve => setImmediate(resolve))
    expect(socket.paused).toBe(false)
    expect(client.sent).toEqual(['a', 'b'])
  })
  test('a replica that never answers a close is terminated after closeTimeoutMs', async () => {
    const { relay: r, socket } = relay({ closeTimeoutMs: 20 })
    r.clientClosed(1000, 'bye')
    expect(socket.frames.at(-1)!.opcode).toBe(8)
    expect(socket.terminated).toBe(false)
    await Bun.sleep(40)
    expect(socket.terminated).toBe(true)
  })
  test('replica protocol errors close the client with 1011 and the replica with the RFC code', () => {
    const { relay: r, socket, client, done } = relay()
    r.receive(frame(1, bytes(0xff)))
    expect(client.closed).toEqual([1011, 'Upstream error'])
    expect([...socket.frames.at(-1)!.payload.subarray(0, 2)]).toEqual([0x03, 0xef]) // 1007
    r.lost()
    expect(done).toEqual(['protocol_error'])
  })
  test('a replica close is echoed and ends the connection', () => {
    const { relay: r, socket, client } = relay()
    r.receive(close(4001, 'done'))
    expect(client.closed).toEqual([4001, 'done'])
    expect(socket.frames.at(-1)!.opcode).toBe(8)
    expect(socket.ended).toBe(true)
  })
  test('attach after the replica is gone closes the client with 1012, or 1001 after goAway', () => {
    const lost = new WebSocketRelay(new FakeSocket(), { maxMessageBytes: 1024, maxBufferedBytes: 4096, closeTimeoutMs: 50 }, new Uint8Array(0))
    lost.lost()
    const client = new FakeClient()
    lost.attach(client)
    expect(client.closed).toEqual([1012, 'Upstream unavailable'])
    const away = new WebSocketRelay(new FakeSocket(), { maxMessageBytes: 1024, maxBufferedBytes: 4096, closeTimeoutMs: 50 }, new Uint8Array(0))
    away.goAway()
    const second = new FakeClient()
    away.attach(second)
    expect(second.closed).toEqual([1001, 'Going away'])
  })
})
