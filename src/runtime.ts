import { resolve } from 'node:path'
import { MonoripperError, type AppDefinition, type ServeOptions } from './definitions'
import { forwardingHeaders, leasedBody, publicError } from './http'
import { owns, validPath, validateApp } from './ownership'
import { assertKeys, trustedProxyList, validateRuntimeConfig } from './config'
import { clientAddress, isTrustedPeer, stripForwarding } from './client-ip'
import { GatewayMetrics } from './metrics'
import { WorkerPool } from './worker-pool'
import { websocketLimits } from './process-worker'
import { connectWebSocket, upstreamHeaders, type WebSocketRelay } from './websocket'
import { StateStore } from './state-store'
import { Controller } from './controller'
import type { ControlStatus, Operation, SetContextRequest, WorkerStatus } from './control-types'

export interface Runtime {
  readonly url: URL
  readonly controlAddress?: string
  readonly adminUrl?: URL
  status(): WorkerStatus[]
  getStatus(): ControlStatus
  setContext(input: SetContextRequest): Promise<Operation>
  getOperation(id: string): Operation
  waitOperation(id: string, timeoutMs?: number): Promise<Operation>
  stop(): Promise<void>
}
function resolveApp(app: AppDefinition, root: string): AppDefinition {
  return { ...app,
    contexts: Object.fromEntries(Object.entries(app.contexts).map(([name, context]) => [name, {
      ...context, entry: resolve(root, context.entry), root: context.root ? resolve(root, context.root) : undefined,
    }])),
    resources: Object.fromEntries(Object.entries(app.resources ?? {}).map(([name, resource]) => [name, { ...resource, entry: resolve(root, resource.entry) }])),
    tsconfig: app.tsconfig ? resolve(root, app.tsconfig) : undefined,
  }
}
export async function serve(options: ServeOptions): Promise<Runtime> {
  assertKeys(options, ['app', 'root', 'initial', 'http', 'lifecycle', 'env', 'onDiagnostic', 'control', 'dataDir', 'environment', 'recovery', 'startupSignal', 'admin', 'logging'], 'serve')
  validateRuntimeConfig(options)
  validateApp(options.app)
  if (options.startupSignal !== undefined && !(options.startupSignal instanceof AbortSignal)) throw new MonoripperError('INVALID_CONFIG', 'startupSignal must be an AbortSignal')
  const assertStarting = () => { if (options.startupSignal?.aborted) throw new MonoripperError('SHUTTING_DOWN', 'Runtime startup cancelled') }
  assertStarting()
  if (options.root !== undefined && typeof options.root !== 'string') throw new MonoripperError('INVALID_CONFIG', 'root must be a path')
  if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== 'function') throw new MonoripperError('INVALID_CONFIG', 'onDiagnostic must be a function')
  options = { ...options, app: structuredClone(options.app), initial: structuredClone(options.initial),
    http: { ...options.http, ...(options.http?.trustedProxies ? { trustedProxies: [...options.http.trustedProxies] } : {}),
      ...(options.http?.websocket ? { websocket: { ...options.http.websocket } } : {}) },
    lifecycle: { ...options.lifecycle }, recovery: { ...options.recovery },
    ...(options.control ? { control: { ...options.control } } : {}), env: { ...options.env },
    ...(options.admin ? { admin: { ...options.admin } } : {}), ...(options.logging ? { logging: { ...options.logging } } : {}) }
  const trusted = options.http?.trustedProxies ? trustedProxyList(options.http.trustedProxies) : undefined
  const root = resolve(options.root ?? process.cwd())
  options.root = root
  const app = resolveApp(options.app, root)
  for (const name of Object.keys(options.initial)) if (!Object.hasOwn(app.contexts, name)) throw new MonoripperError('INVALID_CONFIG', `Unknown initial context: ${name}`)
  const environment = options.environment ?? 'development'
  const token = options.control ? process.env[options.control.tokenEnv] : undefined
  if (options.control && (!token || !/^[\x21-\x7e]{32,512}$/.test(token))) throw new MonoripperError('INVALID_CONFIG', 'Control requires a 32–512 byte printable ASCII credential without whitespace in its configured environment variable')
  const dataDir = options.dataDir ?? (options.control ? `.monoripper/${app.project}/${environment}` : undefined)
  const store = await StateStore.open({ project: app.project, environment, directory: dataDir ? resolve(root, dataDir) : undefined,
    contexts: Object.keys(app.contexts), initial: Object.fromEntries(Object.entries(options.initial).map(([name, value]) => [name, value.replicas])) })
  let controller: Controller
  const pool = new WorkerPool(app, options, context => controller.unexpectedExit(context))
  controller = new Controller(store, pool, options)
  let server: Bun.Server<WebSocketRelay> | undefined
  let control: { address: string; close(): void } | undefined
  let admin: ReturnType<typeof Bun.serve> | undefined
  const metrics = new GatewayMetrics()
  let stopping = false
  let stopPromise: Promise<void> | undefined
  const counters = new Map<string, number>()
  const requestTimeout = options.lifecycle?.requestTimeoutMs ?? 30_000
  const shutdownTimeout = options.lifecycle?.shutdownTimeoutMs ?? 10_000
  const limits = websocketLimits(options)
  const relays = new Set<WebSocketRelay>()
  let handshakes = 0
  const cancelStartup = () => controller.beginClose()
  options.startupSignal?.addEventListener('abort', cancelStartup, { once: true })
  try {
    assertStarting()
    await controller.initialize()
    assertStarting()
    server = Bun.serve<WebSocketRelay>({
      hostname: options.http?.host ?? '127.0.0.1', port: options.http?.port ?? 3000,
      maxRequestBodySize: options.http?.maxRequestBodyBytes ?? 16 * 1024 * 1024, idleTimeout: 30,
      websocket: {
        // The relay enforces maxMessageBytes with a clean 1009; Bun's own ceiling (abrupt 1006) is a backstop.
        maxPayloadLength: Math.min(limits.maxMessageBytes * 2, 0x7fffffff), idleTimeout: limits.idleTimeoutSeconds, sendPings: true, perMessageDeflate: false,
        open(ws) { ws.data.attach(ws) },
        message(ws, message) { ws.data.fromClient(message) },
        close(ws, code, reason) { ws.data.clientClosed(code, reason) },
        drain(ws) { ws.data.clientDrained() },
      },
      async fetch(request, gateway) {
        const started = performance.now()
        let context = '' // Unowned requests have no context label value.
        const reject = (status: number, code: string) => { metrics.gatewayError(context, code); return publicError(status, code) }
        const response = await (async (): Promise<Response | undefined> => {
        if (stopping) return reject(503, 'SHUTTING_DOWN')
        const upgrade = request.headers.get('upgrade')
        const websocket = upgrade?.trim().toLowerCase() === 'websocket'
        if (upgrade !== null && !websocket) return reject(501, 'UPGRADE_NOT_SUPPORTED')
        const url = new URL(request.url)
        if (!validPath(url.pathname)) return reject(400, 'INVALID_PATH')
        // ponytail: linear lookups for small apps; index immutable routing snapshots if profiling warrants it.
        const owner = Object.entries(app.contexts).find(([, context]) => owns(context.owns, websocket ? 'GET' : request.method, url.pathname))?.[0]
        if (!owner) return reject(404, 'NOT_FOUND')
        context = owner
        if (websocket && (request.method !== 'GET' || request.headers.get('sec-websocket-version') !== '13' || !request.headers.get('sec-websocket-key'))) {
          return reject(400, 'INVALID_UPGRADE')
        }
        if (websocket && relays.size + handshakes >= limits.maxConnections) return reject(503, 'WEBSOCKET_LIMIT')
        const ready = pool.ready(owner)
        if (!ready.length) return reject(503, 'CONTEXT_UNAVAILABLE')
        const counter = counters.get(owner) ?? 0
        counters.set(owner, (counter + 1) % ready.length)
        const worker = ready[counter % ready.length]!
        url.protocol = 'http:'; url.hostname = '127.0.0.1'; url.port = String(worker.port)
        const headers = forwardingHeaders(request.headers, true)
        const peer = gateway.requestIP(request)?.address
        if (!isTrustedPeer(trusted, peer)) stripForwarding(headers)
        const client = clientAddress(trusted, peer, request.headers)
        if (client) headers.set('x-monoripper-client-ip', client)
        headers.set('x-monoripper-token', worker.token)
        const deadline = AbortSignal.timeout(requestTimeout)
        if (websocket) {
          handshakes++
          worker.inFlight++
          try {
            const result = await connectWebSocket({ port: worker.port, target: url.pathname + url.search, headers: upstreamHeaders(headers),
              signal: AbortSignal.any([request.signal, deadline]), maxMessageBytes: limits.maxMessageBytes, closeTimeoutMs: shutdownTimeout })
            if (!('relay' in result)) return result.status < 200 ? reject(502, 'UPSTREAM_ERROR') : new Response(result.body, { status: result.status, headers: result.headers })
            const { relay } = result
            if (stopping || worker.draining || worker.exited) { relay.abort(); return reject(503, stopping ? 'SHUTTING_DOWN' : 'CONTEXT_UNAVAILABLE') }
            relay.onDone = reason => { relays.delete(relay); worker.sockets.delete(relay); metrics.websocketClosed(owner, reason) }
            if (!gateway.upgrade(request, { data: relay, headers: result.headers })) { relay.abort(); return reject(400, 'INVALID_UPGRADE') }
            relays.add(relay); worker.sockets.add(relay)
            metrics.websocketOpened(owner)
            return undefined
          } catch {
            return reject(deadline.aborted ? 504 : 502, deadline.aborted ? 'DEADLINE_EXCEEDED' : 'UPSTREAM_ERROR')
          } finally { handshakes--; worker.inFlight-- }
        }
        worker.inFlight++
        let released = false
        const release = () => { if (!released) { released = true; worker.inFlight-- } }
        try {
          const response = await fetch(url, { method: request.method, headers,
            body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
            signal: AbortSignal.any([request.signal, deadline]), redirect: 'manual', decompress: false, proxy: '' })
          return new Response(leasedBody(response.body, release), { status: response.status, statusText: response.statusText, headers: forwardingHeaders(response.headers) })
        } catch {
          release()
          return reject(deadline.aborted ? 504 : 502, deadline.aborted ? 'DEADLINE_EXCEEDED' : 'UPSTREAM_ERROR')
        }
        })()
        metrics.observe(context, request.method, response?.status ?? 101, (performance.now() - started) / 1000)
        return response
      },
      error() { return publicError(500, 'INTERNAL_ERROR') },
    })
    if (options.control) {
      const { startControlServer } = await import('./grpc-server')
      control = await startControlServer(controller, options.control, token!)
    }
    if (options.admin) {
      const readiness = () => {
        const state = controller.status()
        const waiting = state.contexts.filter(c => c.desiredReplicas > 0 && c.readyReplicas === 0).map(c => c.name)
        return { ready: !stopping && controller.store.healthy && !waiting.length, waiting, state }
      }
      admin = Bun.serve({
        hostname: options.admin.host ?? '127.0.0.1', port: options.admin.port ?? 0, idleTimeout: 30,
        async fetch(request) {
          if (request.method !== 'GET' && request.method !== 'HEAD') return publicError(405, 'METHOD_NOT_ALLOWED')
          const path = new URL(request.url).pathname
          if (path === '/-/healthz') return stopping ? publicError(503, 'SHUTTING_DOWN') : Response.json({ status: 'ok' })
          if (path === '/-/readyz') {
            const { ready, waiting } = readiness()
            return ready ? Response.json({ status: 'ready' }) : Response.json({ status: 'not_ready', contexts: waiting }, { status: 503 })
          }
          if (path === '/-/metrics') {
            const { ready, state } = readiness()
            const text = await metrics.render({ project: state.project, environment: state.environment, ready,
              contexts: state.contexts.map(c => ({ ...c, inFlight: pool.inFlight(c.name), websockets: pool.sockets(c.name) })) }, stopping ? [] : pool.targets())
            return new Response(text, { headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' } })
          }
          return publicError(404, 'NOT_FOUND')
        },
        error() { return publicError(500, 'INTERNAL_ERROR') },
      })
    }
    assertStarting()
    const gateway = server
    const adminServer = admin
    return {
      url: new URL(gateway.url), ...(control ? { controlAddress: control.address } : {}), ...(adminServer ? { adminUrl: new URL(adminServer.url) } : {}),
      status: () => pool.status(), getStatus: () => controller.status(), setContext: input => controller.set(input), getOperation: id => controller.operation(id),
      async waitOperation(id, timeoutMs = 30_000) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) throw new MonoripperError('INVALID_ARGUMENT', 'Invalid operation wait timeout')
        const deadline = performance.now() + timeoutMs
        while (true) {
          const operation = controller.operation(id)
          if (operation.phase === 'succeeded' || operation.phase === 'failed') return operation
          if (performance.now() >= deadline) throw new MonoripperError('DEADLINE_EXCEEDED', `Operation ${id} is still running; query it again`)
          await Bun.sleep(10)
        }
      },
      stop() {
        if (stopPromise) return stopPromise
        stopping = true; control?.close(); controller.beginClose()
        for (const relay of relays) relay.goAway()
        stopPromise = (async () => {
          // Bun 1.3.13 never settles a graceful stop() once the server has upgraded a WebSocket; the forced stop below does.
          gateway.stop(false).catch(() => {})
          try { await controller.close() } finally { await gateway.stop(true); await adminServer?.stop(true) }
        })()
        return stopPromise
      },
    }
  } catch (error) {
    control?.close()
    await admin?.stop(true)
    await server?.stop(true)
    try { await controller.close() } catch (cleanupError) {
      if (error instanceof MonoripperError && error.code === 'SHUTTING_DOWN') throw cleanupError
      // Preserve startup failure; close always releases its writer lock.
    }
    throw error
  } finally { options.startupSignal?.removeEventListener('abort', cancelStartup) }
}
