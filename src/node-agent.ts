import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MonoripperError, type RuntimeOptions } from './definitions'
import { assertKeys } from './config'
import { ReleaseCache } from './release-cache'
import { runtimeCompatibility } from './release'
import { registryBase, validToken } from './registry-client'
import { forwardingHeaders, leasedBody, publicError, stripHopByHop } from './http'
import { startWorker, websocketLimits, type ManagedWorker } from './process-worker'
import { connectWebSocket, type WebSocketRelay } from './websocket'
import type { AssignmentSettings, Heartbeat } from './cluster'

export interface NodeConfig {
  /** Stable node name, unique in the cluster. */
  id: string
  project: string
  environment?: string
  /** The controller's cluster endpoint (HTTPS) and the shared cluster credential. */
  controller: { url: string; tokenEnv: string; caFile: string }
  /** This agent's private HTTPS listener; worker ports stay on loopback. */
  listen: { host?: string; port?: number; tls: { certFile: string; keyFile: string } }
  /** HTTPS URL the controller and gateway use to reach `listen`. */
  advertise: string
  /** Release origin; the agent downloads only digests the controller assigns. */
  registry?: { url: string; tokenEnv: string; caFile?: string }
  dataDir: string
  capacity?: { maxReplicas?: number }
  heartbeatMs?: number
  /** Keep equal to the controller's limits; the agent relays WebSockets with them. */
  http?: { websocket?: NonNullable<RuntimeOptions['http']>['websocket'] }
  logging?: RuntimeOptions['logging']
  env?: Record<string, string>
}
export interface NodeAgent { readonly url: URL; stop(): Promise<void> }

const fail: (message: string) => never = message => { throw new MonoripperError('INVALID_CONFIG', message) }
const env = /^[A-Za-z_][A-Za-z0-9_]*$/
export function validateNodeConfig(config: NodeConfig): void {
  assertKeys(config, ['id', 'project', 'environment', 'controller', 'listen', 'advertise', 'registry', 'dataDir', 'capacity', 'heartbeatMs', 'http', 'logging', 'env'], 'node')
  if (typeof config.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(config.id) || config.id === 'local') fail('Invalid node id')
  if (typeof config.project !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.project)) fail('Invalid node project')
  assertKeys(config.controller, ['url', 'tokenEnv', 'caFile'], 'node.controller')
  if (!/^https:\/\//.test(config.controller.url) || !env.test(config.controller.tokenEnv ?? '') || typeof config.controller.caFile !== 'string') fail('node.controller needs an https url, tokenEnv and caFile')
  assertKeys(config.listen, ['host', 'port', 'tls'], 'node.listen')
  assertKeys(config.listen.tls, ['certFile', 'keyFile'], 'node.listen.tls')
  let advertised: URL | undefined
  try { advertised = new URL(config.advertise) } catch { /* reported below */ }
  if (!advertised || advertised.protocol !== 'https:' || advertised.pathname !== '/' || advertised.search || advertised.username) fail('node.advertise must be an https origin such as https://10.0.0.5:7443/')
  if (config.registry !== undefined) {
    assertKeys(config.registry, ['url', 'tokenEnv', 'caFile'], 'node.registry')
    registryBase(config.registry.url)
    if (!env.test(config.registry.tokenEnv ?? '')) fail('node.registry.tokenEnv must name an environment variable')
  }
  if (typeof config.dataDir !== 'string' || !config.dataDir) fail('node.dataDir is required')
  if (config.capacity !== undefined) {
    assertKeys(config.capacity, ['maxReplicas'], 'node.capacity')
    const max = config.capacity.maxReplicas
    if (max !== undefined && (!Number.isSafeInteger(max) || max < 0 || max > 64)) fail('Invalid node.capacity.maxReplicas')
  }
  if (config.heartbeatMs !== undefined && (!Number.isSafeInteger(config.heartbeatMs) || config.heartbeatMs < 10 || config.heartbeatMs > 60_000)) fail('Invalid node.heartbeatMs')
}

export async function loadNodeConfig(filename: string): Promise<NodeConfig> {
  const path = resolve(filename)
  const config = (await import(pathToFileURL(path).href)).default as NodeConfig
  validateNodeConfig(config)
  const base = dirname(path)
  return { ...config, dataDir: resolve(base, config.dataDir),
    controller: { ...config.controller, caFile: resolve(base, config.controller.caFile) },
    listen: { ...config.listen, tls: { certFile: resolve(base, config.listen.tls.certFile), keyFile: resolve(base, config.listen.tls.keyFile) } },
    ...(config.registry ? { registry: { ...config.registry, ...(config.registry.caFile ? { caFile: resolve(base, config.registry.caFile) } : {}) } } : {}) }
}

interface Assigned { worker: ManagedWorker; context: string; release: string; settings: AssignmentSettings }

/**
 * A node agent: starts assigned replicas from verified releases, proxies authenticated gateway traffic to their loopback
 * ports, relays their services calls to the controller, and reports liveness. It never decides placement itself.
 */
export async function startNode(input: NodeConfig): Promise<NodeAgent> {
  validateNodeConfig(input)
  const config = structuredClone(input)
  const token = process.env[config.controller.tokenEnv]
  if (!validToken(token)) fail('The cluster credential must be 32–512 printable ASCII characters')
  const expected = Buffer.from(token)
  const controllerCa = readFileSync(config.controller.caFile, 'utf8')
  let registry
  if (config.registry) {
    const credential = process.env[config.registry.tokenEnv]
    if (!validToken(credential)) fail('Registry read credential must be 32–512 printable ASCII characters')
    registry = { url: config.registry.url, token: credential, ...(config.registry.caFile ? { ca: readFileSync(config.registry.caFile, 'utf8') } : {}) }
  }
  const dataDir = resolve(config.dataDir)
  const cache = await ReleaseCache.open(join(dataDir, 'releases'), registry)
  const instance = crypto.randomUUID()
  const workers = new Map<string, Assigned>()
  const abort = new AbortController()
  const limits = websocketLimits({ initial: {}, ...(config.http ? { http: config.http } : {}) })
  const maxReplicas = config.capacity?.maxReplicas ?? 64
  let generation = 0
  let starting = 0
  let stopping = false
  const relays = new Set<WebSocketRelay>()
  const authorized = (request: Request) => {
    const supplied = Buffer.from(request.headers.get('x-monoripper-cluster-token') ?? '')
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  // Loopback listener for services.fetch from this node's workers, relayed to the controller with the caller's identity.
  const services = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 30, async fetch(request) {
    const supplied = request.headers.get('x-monoripper-services-token') ?? ''
    const caller = supplied ? [...workers.entries()].find(([, item]) => item.worker.servicesToken === supplied && !item.worker.exited) : undefined
    if (!caller) return publicError(401, 'UNAUTHENTICATED')
    const url = new URL(request.url)
    const headers = stripHopByHop(new Headers(request.headers))
    headers.delete('host'); headers.delete('x-monoripper-services-token')
    headers.set('x-monoripper-cluster-token', token); headers.set('x-monoripper-node', config.id); headers.set('x-monoripper-caller-worker', caller[0])
    try {
      const response = await fetch(new URL('/v1/services' + url.pathname + url.search, config.controller.url), { method: request.method, headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body, signal: request.signal, redirect: 'manual', proxy: '', tls: { ca: controllerCa } })
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: forwardingHeaders(response.headers) })
    } catch { return publicError(502, 'UPSTREAM_ERROR') }
  } })

  async function start(request: Request): Promise<Response> {
    let body: { id?: unknown; context?: unknown; release?: unknown; project?: unknown; settings?: AssignmentSettings }
    try { body = await request.json() } catch { return publicError(400, 'INVALID_ASSIGNMENT') }
    const { id, context, release, project, settings } = body
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || typeof context !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(context)
      || typeof release !== 'string' || project !== config.project || !settings || typeof settings !== 'object') return publicError(400, 'INVALID_ASSIGNMENT')
    if (workers.has(id)) return publicError(409, 'ALREADY_EXISTS')
    if (stopping) return publicError(503, 'SHUTTING_DOWN')
    if (workers.size + starting >= maxReplicas) return publicError(507, 'CAPACITY_EXCEEDED')
    starting++
    try {
      const loaded = await cache.ensure(config.project, release)
      if (!loaded.manifest.contexts[context]) return publicError(422, 'RELEASE_CONTEXT_MISSING')
      const cwd = join(dataDir, 'work', context)
      await mkdir(cwd, { recursive: true, mode: 0o700 })
      const options: RuntimeOptions = { initial: {}, root: cwd, lifecycle: { startupTimeoutMs: settings.startupTimeoutMs, shutdownTimeoutMs: settings.shutdownTimeoutMs },
        http: { maxRequestBodyBytes: settings.maxRequestBodyBytes, websocket: settings.websocket }, ...(config.logging ? { logging: config.logging } : {}),
        env: { ...config.env, [config.controller.tokenEnv]: '', ...(config.registry ? { [config.registry.tokenEnv]: '' } : {}) } }
      const worker = await startWorker(context, { app: loaded.app, cwd, release, services: services.url.href }, options, exited => {
        if (workers.get(id)?.worker === exited) { workers.delete(id); generation++ }
      }, abort.signal)
      worker.published = true
      workers.set(id, { worker, context, release, settings })
      generation++
      return Response.json({ id, pid: worker.pid, generation }, { status: 201 })
    } catch (error) {
      const code = error instanceof MonoripperError ? error.code : 'CONTEXT_START_FAILED'
      return publicError(code === 'RELEASE_NOT_FOUND' || code.startsWith('DOWNLOAD') || code.startsWith('REGISTRY') ? 503 : 500, code)
    } finally { starting-- }
  }

  async function stopWorker(id: string, timeoutMs?: number, force = false): Promise<Response> {
    const assigned = workers.get(id)
    if (!assigned) return publicError(404, 'NOT_FOUND')
    assigned.worker.draining = true
    try {
      if (force) await assigned.worker.kill()
      else await assigned.worker.stop(timeoutMs ?? assigned.settings.shutdownTimeoutMs)
      return Response.json({ id, stopped: true })
    } catch (error) {
      return publicError(500, error instanceof MonoripperError ? error.code : 'CONTEXT_STOP_FAILED')
    } finally { workers.delete(id); generation++ }
  }

  async function proxy(request: Request, server: Bun.Server<WebSocketRelay>, assigned: Assigned): Promise<Response | undefined> {
    const { worker } = assigned
    if (worker.exited) return publicError(503, 'CONTEXT_UNAVAILABLE')
    const url = new URL(request.url)
    const headers = stripHopByHop(new Headers(request.headers))
    headers.delete('host'); headers.delete('x-monoripper-cluster-token'); headers.delete('x-monoripper-worker')
    headers.set('x-monoripper-token', worker.token)
    const budget = Number(request.headers.get('x-monoripper-deadline-ms'))
    const deadline = AbortSignal.timeout(Number.isSafeInteger(budget) && budget > 0 ? budget : 30_000)
    if (request.headers.get('upgrade')?.trim().toLowerCase() === 'websocket') {
      try {
        const result = await connectWebSocket({ port: worker.port, target: url.pathname + url.search, headers, signal: AbortSignal.any([request.signal, deadline]),
          maxMessageBytes: limits.maxMessageBytes, maxBufferedBytes: limits.maxBufferedBytes, closeTimeoutMs: 1000, idleTimeoutMs: limits.idleTimeoutSeconds * 1000 })
        if (!('relay' in result)) return new Response(result.body, { status: result.status, headers: result.headers })
        const { relay } = result
        relays.add(relay); worker.sockets.add(relay)
        relay.onDone = () => { relays.delete(relay); worker.sockets.delete(relay) }
        let upgraded = false
        try { upgraded = server.upgrade(request, { data: relay, headers: result.headers }) } catch { /* not upgraded */ }
        if (!upgraded) { relays.delete(relay); worker.sockets.delete(relay); relay.abort(); return publicError(400, 'INVALID_UPGRADE') }
        return undefined
      } catch { return publicError(deadline.aborted ? 504 : 502, deadline.aborted ? 'DEADLINE_EXCEEDED' : 'UPSTREAM_ERROR') }
    }
    worker.inFlight++
    let released = false
    const release = () => { if (!released) { released = true; worker.inFlight-- } }
    try {
      const response = await fetch(`http://127.0.0.1:${worker.port}${url.pathname}${url.search}`, { method: request.method, headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body, signal: AbortSignal.any([request.signal, deadline]),
        redirect: 'manual', decompress: false, proxy: '' })
      return new Response(leasedBody(response.body, release), { status: response.status, statusText: response.statusText, headers: forwardingHeaders(response.headers) })
    } catch {
      release()
      return publicError(deadline.aborted ? 504 : 502, deadline.aborted ? 'DEADLINE_EXCEEDED' : 'UPSTREAM_ERROR')
    }
  }

  const server = Bun.serve<WebSocketRelay>({
    hostname: config.listen.host ?? '127.0.0.1', port: config.listen.port ?? 0, idleTimeout: 60, maxRequestBodySize: 256 * 1024 * 1024,
    tls: { cert: readFileSync(config.listen.tls.certFile, 'utf8'), key: readFileSync(config.listen.tls.keyFile, 'utf8') },
    websocket: {
      maxPayloadLength: Math.min(limits.maxMessageBytes * 2, 0x7fffffff), idleTimeout: limits.idleTimeoutSeconds, sendPings: true, perMessageDeflate: false,
      backpressureLimit: limits.maxBufferedBytes, closeOnBackpressureLimit: true,
      open(ws) { ws.data.attach(ws) }, message(ws, message) { ws.data.fromClient(message) },
      close(ws, code, reason) { ws.data.clientClosed(code, reason) }, drain(ws) { ws.data.clientDrained() },
    },
    async fetch(request, gateway) {
      if (!authorized(request)) return publicError(401, 'UNAUTHENTICATED')
      const target = request.headers.get('x-monoripper-worker')
      if (target !== null) {
        const assigned = workers.get(target)
        return assigned ? proxy(request, gateway, assigned) : publicError(503, 'CONTEXT_UNAVAILABLE')
      }
      const path = new URL(request.url).pathname
      if (path === '/v1/workers' && request.method === 'GET') {
        return Response.json([...workers.entries()].map(([id, item]) => ({ id, context: item.context, release: item.release, pid: item.worker.pid, ready: !item.worker.exited })))
      }
      if (request.method !== 'POST') return publicError(405, 'METHOD_NOT_ALLOWED')
      if (path === '/v1/workers') return start(request)
      const match = /^\/v1\/workers\/([a-f0-9-]{36})\/(stop|kill)$/.exec(path)
      if (!match) return publicError(404, 'NOT_FOUND')
      const body = await request.json().catch(() => ({})) as { timeoutMs?: unknown }
      const timeout = Number.isSafeInteger(body.timeoutMs) && Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : undefined
      return stopWorker(match[1]!, timeout, match[2] === 'kill')
    },
    error() { return publicError(500, 'INTERNAL_ERROR') },
  })

  const interval = config.heartbeatMs ?? 1000
  let timer: ReturnType<typeof setTimeout> | undefined
  const beat = async () => {
    const body: Heartbeat = { instance, id: config.id, url: config.advertise, project: config.project, environment: config.environment ?? 'development',
      maxReplicas, compatibility: runtimeCompatibility(), generation,
      workers: [...workers.entries()].map(([id, item]) => ({ id, context: item.context, release: item.release, pid: item.worker.pid, ready: !item.worker.exited })) }
    try {
      const response = await fetch(new URL('/v1/nodes/heartbeat', config.controller.url), { method: 'POST', body: JSON.stringify(body), proxy: '', redirect: 'manual',
        headers: { 'content-type': 'application/json', 'x-monoripper-cluster-token': token }, tls: { ca: controllerCa }, signal: AbortSignal.timeout(Math.max(1000, interval * 3)) })
      if (response.status === 200) {
        const { stop } = await response.json() as { stop?: unknown }
        // Replicas the controller no longer counts (replaced during a partition, or from a previous controller) must not serve.
        if (Array.isArray(stop)) for (const id of stop) if (typeof id === 'string' && workers.has(id)) void stopWorker(id)
      } else await response.body?.cancel()
    } catch { /* the controller is unreachable; keep serving and retry */ }
    if (!stopping) timer = setTimeout(beat, interval)
  }
  void beat()

  return {
    url: new URL(server.url),
    async stop() {
      stopping = true
      clearTimeout(timer)
      abort.abort()
      for (const relay of relays) relay.goAway()
      await Promise.allSettled([...workers.keys()].map(id => stopWorker(id)))
      server.stop(false).catch(() => {})
      await server.stop(true)
      await services.stop(true)
    },
  }
}
