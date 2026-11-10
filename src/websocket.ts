import { createHash, randomBytes } from 'node:crypto'
import type { ServerWebSocket, Socket } from 'bun'
import { forwardingHeaders } from './http'

const guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const maxHead = 16 * 1024
const maxRejectedBody = 64 * 1024
const minPendingBytes = 16 * 1024 * 1024
const encoder = new TextEncoder()
const utf8 = new TextDecoder('utf-8', { fatal: true })
const latin1 = new TextDecoder('latin1')
const handshakeOnly = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-accept']

export type CloseReason = 'client' | 'upstream' | 'going_away' | 'upstream_lost' | 'protocol_error' | 'message_too_big' | 'backpressure'
export interface Rejected { status: number; headers: Headers; body: Uint8Array<ArrayBuffer> | null }
export interface ConnectOptions {
  port: number; target: string; headers: Headers; signal: AbortSignal
  maxMessageBytes: number; closeTimeoutMs: number
}

/** Codes an endpoint may put on the wire (RFC 6455 §7.4). */
export const sendableCode = (code: number) => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)

/** Handshake headers for the replica: end-to-end request headers without the client's key/extensions. */
export function upstreamHeaders(headers: Headers): Headers {
  for (const name of handshakeOnly) headers.delete(name)
  return headers
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a); out.set(b, a.length)
  return out
}

/** Received bytes kept as chunks so large messages are copied once. */
class ByteQueue {
  private chunks: Uint8Array[] = []
  length = 0
  push(chunk: Uint8Array) { this.chunks.push(chunk); this.length += chunk.length }
  peek(count: number): Uint8Array {
    if (this.chunks[0]!.length >= count) return this.chunks[0]!.subarray(0, count)
    const out = new Uint8Array(count)
    let offset = 0
    for (const chunk of this.chunks) { const part = chunk.subarray(0, count - offset); out.set(part, offset); offset += part.length; if (offset === count) break }
    return out
  }
  take(count: number): Uint8Array {
    const out = new Uint8Array(count)
    let offset = 0
    while (offset < count) {
      const chunk = this.chunks[0]!
      const part = chunk.subarray(0, count - offset)
      out.set(part, offset); offset += part.length
      if (part.length === chunk.length) this.chunks.shift(); else this.chunks[0] = chunk.subarray(part.length)
    }
    this.length -= count
    return out
  }
}

function frame(opcode: number, payload: Uint8Array): Uint8Array {
  const length = payload.length
  const head = 2 + (length < 126 ? 0 : length < 65536 ? 2 : 8) + 4
  const out = new Uint8Array(head + length)
  out[0] = 0x80 | opcode
  if (length < 126) out[1] = 0x80 | length
  else if (length < 65536) { out[1] = 0x80 | 126; out[2] = length >> 8; out[3] = length & 0xff }
  else { out[1] = 0x80 | 127; new DataView(out.buffer).setBigUint64(2, BigInt(length)) }
  const mask = randomBytes(4)
  out.set(mask, head - 4)
  for (let index = 0; index < length; index++) out[head + index] = payload[index]! ^ mask[index & 3]!
  return out
}

function closePayload(code: number | undefined, reason: string): Uint8Array {
  if (code === undefined) return new Uint8Array(0)
  let text = encoder.encode(reason)
  if (text.length > 123) text = encoder.encode(new TextDecoder().decode(text.subarray(0, 123), { stream: true }))
  const out = new Uint8Array(2 + text.length)
  out[0] = code >> 8; out[1] = code & 0xff; out.set(text, 2)
  return out
}

/**
 * Opens a WebSocket to a replica over raw TCP so a refused handshake keeps its HTTP status.
 * Resolves a paused relay on 101 or the upstream response otherwise; throws on transport failure.
 */
export async function connectWebSocket(options: ConnectOptions): Promise<{ relay: WebSocketRelay; headers: Headers } | Rejected> {
  const key = randomBytes(16).toString('base64')
  const accept = createHash('sha1').update(key + guid).digest('base64')
  const offered = (options.headers.get('sec-websocket-protocol') ?? '').split(',').map(item => item.trim()).filter(Boolean)
  let head: Uint8Array = new Uint8Array(0)
  let rejected: (Rejected & { length: number; chunks: Uint8Array }) | undefined
  let relay: WebSocketRelay | undefined
  let resolve!: (value: { relay: WebSocketRelay; headers: Headers } | Rejected) => void, reject!: (error: Error) => void
  const result = new Promise<{ relay: WebSocketRelay; headers: Headers } | Rejected>((ok, fail) => { resolve = ok; reject = fail })
  const fail = (message: string) => { reject(new Error(message)); socketRef?.terminate() }
  const finishRejected = () => {
    if (!rejected) return
    const { status, headers, chunks, length } = rejected
    resolve({ status, headers, body: chunks.length >= length && length > 0 ? chunks.slice(0, length) : null })
    socketRef?.terminate()
  }
  let socketRef: Socket<undefined> | undefined
  const onHead = (socket: Socket<undefined>, chunk: Uint8Array) => {
    if (rejected) { rejected.chunks = concat(rejected.chunks, chunk); if (rejected.chunks.length >= rejected.length) finishRejected(); return }
    head = concat(head, chunk)
    let end = -1
    for (let index = 3; index < head.length; index++) if (head[index] === 10 && head[index - 1] === 13 && head[index - 2] === 10 && head[index - 3] === 13) { end = index - 3; break }
    if (end < 0) { if (head.length > maxHead) fail('Upstream handshake head too large'); return }
    const [statusLine, ...lines] = latin1.decode(head.subarray(0, end)).split('\r\n')
    const status = Number(/^HTTP\/1\.1 (\d{3})(?: |$)/.exec(statusLine ?? '')?.[1])
    const headers = new Headers()
    try {
      for (const line of lines) {
        const colon = line.indexOf(':')
        if (colon <= 0) throw new Error('Malformed upstream header')
        headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
      }
    } catch { fail('Malformed upstream handshake'); return }
    if (!(status >= 100 && status <= 599)) { fail('Malformed upstream status'); return }
    const rest = head.subarray(end + 4)
    if (status !== 101) {
      const declared = Number(headers.get('content-length'))
      const length = Number.isSafeInteger(declared) && declared > 0 && declared <= maxRejectedBody && !headers.has('transfer-encoding') ? declared : 0
      for (const name of ['content-length', 'transfer-encoding']) headers.delete(name)
      rejected = { status, headers, body: null, length, chunks: rest }
      if (rest.length >= length) finishRejected()
      return
    }
    const protocol = headers.get('sec-websocket-protocol')
    if (headers.get('upgrade')?.toLowerCase() !== 'websocket' || headers.get('sec-websocket-accept') !== accept
      || headers.has('sec-websocket-extensions') || (protocol !== null && !offered.includes(protocol))) { fail('Invalid upstream handshake'); return }
    socket.pause()
    relay = new WebSocketRelay(socket, options.maxMessageBytes, options.closeTimeoutMs, rest)
    const forwarded = forwardingHeaders(headers)
    for (const name of [...handshakeOnly, 'date', 'content-length']) forwarded.delete(name)
    resolve({ relay, headers: forwarded })
  }
  const abort = () => fail('Upstream handshake aborted')
  options.signal.addEventListener('abort', abort, { once: true })
  try {
    if (options.signal.aborted) throw new Error('Upstream handshake aborted')
    socketRef = await Bun.connect({ hostname: '127.0.0.1', port: options.port, socket: {
      data(socket, chunk) { if (relay) relay.receive(chunk); else onHead(socket, chunk) },
      drain() { relay?.flush() },
      end(socket) { socket.end() },
      close() { if (relay) relay.lost(); else if (rejected) finishRejected(); else fail('Upstream closed during handshake') },
      error() { if (relay) relay.lost(); else fail('Upstream error during handshake') },
    } })
    if (options.signal.aborted) abort()
    const lines = [`GET ${options.target} HTTP/1.1`, `Host: 127.0.0.1:${options.port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13']
    for (const [name, value] of options.headers) lines.push(`${name}: ${value}`)
    socketRef.write(lines.join('\r\n') + '\r\n\r\n')
    return await result
  } finally { options.signal.removeEventListener('abort', abort) }
}

/** Relays one client WebSocket to one replica connection. `done` fires once the replica connection is closed. */
export class WebSocketRelay {
  onDone: (reason: CloseReason) => void = () => {}
  private client?: ServerWebSocket<WebSocketRelay>
  private fragments: Uint8Array[] = []
  private fragmentBytes = 0
  private fragmentOpcode = 0
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private readonly pendingLimit: number
  private paused = true
  private sentClose = false
  private receivedClose = false
  private clientClosing = false
  private ending = false
  private broken = false
  private finished = false
  private reason?: CloseReason
  private timer?: ReturnType<typeof setTimeout>

  private input = new ByteQueue()

  constructor(private socket: Socket<undefined>, private maxMessageBytes: number, private closeTimeoutMs: number, initial: Uint8Array) {
    this.pendingLimit = Math.max(minPendingBytes, maxMessageBytes * 2)
    if (initial.length) this.input.push(initial)
  }

  attach(client: ServerWebSocket<WebSocketRelay>): void {
    this.client = client
    if (this.finished || this.sentClose) this.closeClient(this.reason === 'going_away' ? 1001 : 1012, this.reason === 'going_away' ? 'Going away' : 'Upstream unavailable')
    else this.resume()
  }
  /** Drop a relay whose client upgrade never happened. */
  abort(): void { this.finished = true; this.socket.terminate() }
  goAway(): void { this.shut('going_away', 1001, 'Going away', 1001, 'Going away') }

  fromClient(message: string | Uint8Array): void {
    if (this.sentClose) return
    const payload = typeof message === 'string' ? encoder.encode(message) : message
    if (payload.length > this.maxMessageBytes) return this.shut('message_too_big', 1009, 'Message too big', 1009, '')
    this.write(frame(typeof message === 'string' ? 1 : 2, payload))
    if (this.pendingBytes > this.pendingLimit) {
      this.reason ??= 'backpressure'
      this.closeClient(1013, 'Backpressure')
      this.socket.terminate()
    }
  }
  clientClosed(code: number, reason: string): void {
    this.clientClosing = true
    // Bun drops clients above the server's maxPayloadLength with 1006 and this reason.
    this.reason ??= code === 1009 || reason === 'Received too big message' ? 'message_too_big' : 'client'
    this.sendClose(code === 1005 ? undefined : sendableCode(code) ? code : 1001, sendableCode(code) ? reason : '')
  }
  // Resuming inside Bun's drain callback can miss the next drain, so defer it.
  clientDrained(): void { setImmediate(() => { if (this.client && this.paused && !this.finished) this.resume() }) }

  receive(chunk: Uint8Array): void { this.input.push(chunk); this.parse() }
  flush(): void {
    while (this.pending.length) {
      const chunk = this.pending[0]!
      const written = Math.max(0, this.socket.write(chunk))
      this.pendingBytes -= written
      if (written < chunk.length) { this.pending[0] = chunk.subarray(written); return }
      this.pending.shift()
    }
    if (this.ending) this.socket.end()
  }
  lost(): void {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timer)
    this.reason ??= 'upstream_lost'
    this.closeClient(1012, 'Upstream unavailable')
    this.onDone(this.reason)
  }

  private resume() { this.paused = false; this.socket.resume(); this.parse() }
  private write(bytes: Uint8Array) {
    if (this.finished) return
    if (this.pendingBytes) { this.pending.push(bytes); this.pendingBytes += bytes.length; return }
    const written = Math.max(0, this.socket.write(bytes))
    if (written < bytes.length) { this.pending.push(bytes.subarray(written)); this.pendingBytes += bytes.length - written }
  }
  private end() { this.ending = true; if (!this.pendingBytes) this.socket.end() }
  private closeClient(code: number | undefined, reason: string) {
    if (this.clientClosing || !this.client) return
    this.clientClosing = true
    if (code === undefined) this.client.close(); else this.client.close(code, reason)
  }
  private sendClose(code: number | undefined, reason: string) {
    if (this.sentClose || this.finished) return
    this.sentClose = true
    this.write(frame(8, closePayload(code, reason)))
    if (this.receivedClose) this.end()
    else this.timer = setTimeout(() => this.socket.terminate(), this.closeTimeoutMs)
  }
  private shut(label: CloseReason, clientCode: number, clientReason: string, upstreamCode: number, upstreamReason: string) {
    if (label !== 'going_away') this.broken = true
    this.reason ??= label
    this.closeClient(clientCode, clientReason)
    this.sendClose(upstreamCode, upstreamReason)
  }

  private parse() {
    while (!this.paused && !this.finished && !this.receivedClose && !this.broken) {
      const available = this.input.length
      if (available < 2) return
      const bytes = this.input.peek(Math.min(available, 14))
      const fin = (bytes[0]! & 0x80) !== 0, opcode = bytes[0]! & 0x0f
      let length = bytes[1]! & 0x7f, offset = 2
      if ((bytes[0]! & 0x70) || (bytes[1]! & 0x80)) return this.shut('protocol_error', 1011, 'Upstream error', 1002, '')
      if (length === 126) { if (bytes.length < 4) return; length = (bytes[2]! << 8) | bytes[3]!; offset = 4 }
      else if (length === 127) {
        if (bytes.length < 10) return
        const big = new DataView(bytes.buffer, bytes.byteOffset + 2, 8).getBigUint64(0)
        length = big > BigInt(this.maxMessageBytes) ? this.maxMessageBytes + 1 : Number(big); offset = 10
      }
      if (opcode >= 8 && (!fin || length > 125)) return this.shut('protocol_error', 1011, 'Upstream error', 1002, '')
      if (opcode < 8 && this.fragmentBytes + length > this.maxMessageBytes) return this.shut('message_too_big', 1009, 'Message too big', 1009, '')
      if (available < offset + length) return
      this.input.take(offset)
      this.frame(fin, opcode, this.input.take(length))
    }
  }
  private frame(fin: boolean, opcode: number, payload: Uint8Array) {
    if (opcode === 9) { this.write(frame(10, payload)); return }
    if (opcode === 10) return
    if (opcode === 8) {
      if (payload.length === 1) return this.shut('protocol_error', 1011, 'Upstream error', 1002, '')
      const code = payload.length ? (payload[0]! << 8) | payload[1]! : 1005
      let reason: string
      try { reason = utf8.decode(payload.subarray(2)) } catch { return this.shut('protocol_error', 1011, 'Upstream error', 1007, '') }
      if (code !== 1005 && !sendableCode(code)) return this.shut('protocol_error', 1011, 'Upstream error', 1002, '')
      this.receivedClose = true
      this.reason ??= 'upstream'
      this.closeClient(code === 1005 ? undefined : code, reason)
      if (this.sentClose) this.end(); else this.sendClose(code === 1005 ? undefined : code, reason)
      return
    }
    if (opcode === 0 ? !this.fragmentOpcode : (opcode !== 1 && opcode !== 2) || this.fragmentOpcode) {
      return this.shut('protocol_error', 1011, 'Upstream error', 1002, '')
    }
    if (opcode !== 0 && fin) return this.deliver(opcode, payload)
    if (opcode !== 0) this.fragmentOpcode = opcode
    this.fragments.push(payload)
    this.fragmentBytes += payload.length
    if (!fin) return
    const message = new Uint8Array(this.fragmentBytes)
    let offset = 0
    for (const part of this.fragments) { message.set(part, offset); offset += part.length }
    const kind = this.fragmentOpcode
    this.fragments = []; this.fragmentBytes = 0; this.fragmentOpcode = 0
    this.deliver(kind, message)
  }
  private deliver(opcode: number, payload: Uint8Array) {
    if (this.clientClosing || !this.client) return
    let status: number
    if (opcode === 1) {
      let text: string
      try { text = utf8.decode(payload) } catch { return this.shut('protocol_error', 1011, 'Upstream error', 1007, '') }
      status = this.client.sendText(text)
    } else status = this.client.sendBinary(payload)
    if (status === -1) { this.paused = true; this.socket.pause() }
  }
}
