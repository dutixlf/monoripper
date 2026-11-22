import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { MonoripperError, type RuntimeOptions } from './definitions'
import type { ManagedWorker } from './process-worker'
import type { NodeStatus } from './control-types'
import type { ReleaseCompatibility } from './release'
import { publicError } from './http'

/** Worker settings the controller sends with every assignment so all nodes behave alike. */
export interface AssignmentSettings {
  startupTimeoutMs: number; shutdownTimeoutMs: number; maxRequestBodyBytes: number
  websocket: { maxMessageBytes: number; idleTimeoutSeconds: number; maxBufferedBytes: number }
}
export interface Heartbeat {
  /** Random per agent process; a new instance means the previous one's replicas are gone. */
  instance: string
  id: string; url: string; project: string; environment: string; maxReplicas: number; compatibility: ReleaseCompatibility
  /** Agent-local counter of worker set changes at snapshot time; orders heartbeats against start responses. */
  generation: number
  workers: { id: string; context: string; release: string; pid: number; ready: boolean }[]
}
interface NodeRecord {
  id: string; instance: string; url: URL; maxReplicas: number; compatibility: ReleaseCompatibility
  lastSeen: number; healthy: boolean; blockedUntil: number
  /** Replicas this controller assigned and still counts as live, by worker id. */
  workers: Map<string, { worker: ManagedWorker; generation: number; lose(): void }>
  /** Assignments whose start request has not answered yet; heartbeats must not stop them. */
  pending: Set<string>
}
type Settings = NonNullable<RuntimeOptions['cluster']>

/**
 * Controller side of multi-node operation: an HTTPS endpoint for agent heartbeats and services calls,
 * node health, and remote replicas that the gateway reaches through each agent.
 */
export class Cluster {
  private nodes = new Map<string, NodeRecord>()
  private server?: ReturnType<typeof Bun.serve>
  private timer?: ReturnType<typeof setInterval>
  private readonly ca: string
  private readonly expected: Buffer
  readonly heartbeatTimeoutMs: number
  constructor(private settings: Settings, private token: string, private scope: { project: string; environment: string },
    private servicesCall: (request: Request, caller: { context: string }) => Promise<Response>, private onNodeReady: () => void = () => {}) {
    this.ca = readFileSync(settings.caFile, 'utf8')
    this.expected = Buffer.from(token)
    this.heartbeatTimeoutMs = settings.heartbeatTimeoutMs ?? 5000
  }

  get url() { return this.server ? new URL(this.server.url) : undefined }

  start() {
    this.server = Bun.serve({
      hostname: this.settings.host ?? '127.0.0.1', port: this.settings.port ?? 0, idleTimeout: 60,
      tls: { cert: readFileSync(this.settings.tls.certFile, 'utf8'), key: readFileSync(this.settings.tls.keyFile, 'utf8') },
      fetch: request => this.handle(request),
      error() { return publicError(500, 'INTERNAL_ERROR') },
    })
    this.timer = setInterval(() => this.expire(), Math.max(50, Math.floor(this.heartbeatTimeoutMs / 4)))
  }

  async stop() {
    clearInterval(this.timer)
    await this.server?.stop(true)
  }

  status(): NodeStatus[] {
    const now = performance.now()
    return [...this.nodes.values()].map(node => ({ id: node.id, healthy: node.healthy, maxReplicas: node.maxReplicas, replicas: node.workers.size,
      lastSeenMs: Math.max(0, Math.round(now - node.lastSeen)) }))
  }

  /** Healthy nodes that run the release's runtime and have a free slot, fewest replicas first. */
  placeable(compatibility: ReleaseCompatibility | undefined): { id: string; free: number; replicas: number }[] {
    if (!compatibility) return []
    const now = performance.now()
    return [...this.nodes.values()]
      .filter(node => node.healthy && node.blockedUntil <= now && (Object.keys(compatibility) as (keyof ReleaseCompatibility)[]).every(key => node.compatibility[key] === compatibility[key]))
      .map(node => ({ id: node.id, free: node.maxReplicas - node.workers.size - node.pending.size, replicas: node.workers.size + node.pending.size }))
      .filter(node => node.free > 0)
  }

  private authorized(request: Request) {
    const supplied = Buffer.from(request.headers.get('x-monoripper-cluster-token') ?? '')
    return supplied.length === this.expected.length && timingSafeEqual(supplied, this.expected)
  }

  private async agent(node: NodeRecord, path: string, body: unknown, timeoutMs: number): Promise<Response> {
    return fetch(new URL(path, node.url), { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', proxy: '',
      headers: { 'content-type': 'application/json', 'x-monoripper-cluster-token': this.token }, tls: { ca: this.ca } })
  }

  /**
   * Starts one replica on a node agent. Transport failures (unreachable address, untrusted certificate) block the node
   * for one heartbeat timeout and surface as NODE_UNREACHABLE so placement can try another node.
   */
  async startWorker(nodeId: string, context: string, release: string, settings: AssignmentSettings, onExit: (worker: ManagedWorker) => void): Promise<ManagedWorker> {
    const node = this.nodes.get(nodeId)
    if (!node) throw new MonoripperError('NODE_UNREACHABLE', `Node ${nodeId} is not connected`)
    const id = crypto.randomUUID()
    let response: Response
    node.pending.add(id)
    try { response = await this.agent(node, '/v1/workers', { id, context, release, project: this.scope.project, settings }, settings.startupTimeoutMs + 60_000) }
    catch {
      node.pending.delete(id)
      node.blockedUntil = performance.now() + this.heartbeatTimeoutMs
      throw new MonoripperError('NODE_UNREACHABLE', `Node ${nodeId} is unreachable at its advertised address`)
    }
    const result = await response.json().catch(() => ({})) as { pid?: number; generation?: number; error?: string }
    if (response.status !== 201 || !Number.isSafeInteger(result.pid) || !Number.isSafeInteger(result.generation)) {
      node.pending.delete(id)
      const code = typeof result.error === 'string' && /^[A-Z_]{1,64}$/.test(result.error) ? result.error : 'CONTEXT_START_FAILED'
      throw new MonoripperError(code, `${context} failed to start on node ${nodeId}`)
    }
    let lost = false
    const lose = () => {
      if (lost) return
      lost = true
      worker.exited = true
      node.workers.delete(id)
      onExit(worker)
    }
    const worker: ManagedWorker = {
      context, pid: result.pid!, port: Number(node.url.port), token: '', release, node: nodeId, id, servicesToken: '',
      endpoint: { hostname: node.url.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(node.url.port), tls: { ca: this.ca },
        headers: { 'x-monoripper-cluster-token': this.token, 'x-monoripper-worker': id } },
      exited: false, draining: false, published: false, inFlight: 0, sockets: new Set(),
      stop: async timeoutMs => {
        if (lost) return
        // A node that left or missed heartbeats cannot confirm a stop; reconciliation stops the process when it returns.
        if (!node.healthy) { lose(); return }
        try {
          const stopped = await this.agent(node, `/v1/workers/${id}/stop`, { timeoutMs: timeoutMs ?? settings.shutdownTimeoutMs }, (timeoutMs ?? settings.shutdownTimeoutMs) + 5000)
          const body = await stopped.json().catch(() => ({})) as { error?: string }
          if (stopped.status !== 200 && stopped.status !== 404) throw new MonoripperError(body.error && /^[A-Z_]{1,64}$/.test(body.error) ? body.error : 'CONTEXT_STOP_FAILED', `${context} failed to stop on node ${nodeId}`)
        } catch (error) {
          if (error instanceof MonoripperError) throw error
          throw new MonoripperError('NODE_UNREACHABLE', `Node ${nodeId} did not confirm the stop; the process may still run`)
        } finally { lose() }
      },
      kill: async () => {
        if (lost) return
        try { await this.agent(node, `/v1/workers/${id}/kill`, {}, 5000) } catch { /* the node may be partitioned; heartbeat reconciliation stops it later */ }
        finally { lose() }
      },
    }
    node.workers.set(id, { worker, generation: result.generation!, lose })
    node.pending.delete(id)
    return worker
  }

  private async handle(request: Request): Promise<Response> {
    if (!this.authorized(request)) return publicError(401, 'UNAUTHENTICATED')
    const url = new URL(request.url)
    if (url.pathname === '/v1/nodes/heartbeat' && request.method === 'POST') {
      let beat: Heartbeat
      try { beat = await request.json() as Heartbeat } catch { return publicError(400, 'INVALID_HEARTBEAT') }
      if (beat.project !== this.scope.project || beat.environment !== this.scope.environment) return publicError(403, 'WRONG_SCOPE')
      return Response.json({ stop: this.heartbeat(beat) })
    }
    if (url.pathname === '/v1/nodes/leave' && request.method === 'POST') {
      // A gracefully stopping agent has stopped its replicas itself; withdraw them now instead of after the heartbeat timeout.
      const { id, instance } = await request.json().catch(() => ({})) as { id?: unknown; instance?: unknown }
      const node = typeof id === 'string' ? this.nodes.get(id) : undefined
      if (node && node.instance === instance) {
        node.healthy = false
        for (const record of [...node.workers.values()]) record.lose()
      }
      return Response.json({ ok: true })
    }
    if (url.pathname.startsWith('/v1/services/')) {
      const node = this.nodes.get(request.headers.get('x-monoripper-node') ?? '')
      const caller = node?.healthy ? node.workers.get(request.headers.get('x-monoripper-caller-worker') ?? '')?.worker : undefined
      if (!caller || caller.exited) return publicError(401, 'UNAUTHENTICATED')
      const target = new URL(url.pathname.slice('/v1/services'.length) + url.search, 'http://services.local')
      return this.servicesCall(new Request(target, request), caller)
    }
    return publicError(404, 'NOT_FOUND')
  }

  /** Records liveness and returns replicas the agent must stop: ones this controller never assigned or already replaced. */
  private heartbeat(beat: Heartbeat): string[] {
    const valid = typeof beat.instance === 'string' && beat.instance.length <= 64 && typeof beat.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(beat.id) && beat.id !== 'local'
      && Number.isSafeInteger(beat.maxReplicas) && beat.maxReplicas >= 0 && beat.maxReplicas <= 64 && Array.isArray(beat.workers) && Number.isSafeInteger(beat.generation)
    if (!valid) return []
    let url: URL
    try { url = new URL(beat.url) } catch { return [] }
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.username) return []
    let node = this.nodes.get(beat.id)
    if (!node) {
      node = { id: beat.id, instance: beat.instance, url, maxReplicas: beat.maxReplicas, compatibility: beat.compatibility, lastSeen: 0, healthy: false, blockedUntil: 0, workers: new Map(), pending: new Set() }
      this.nodes.set(beat.id, node)
    }
    if (node.url.href !== url.href || node.instance !== beat.instance) {
      // A restarted or moved agent: its predecessor's replicas are gone from routing.
      for (const record of [...node.workers.values()]) record.lose()
      node.url = url
      node.instance = beat.instance
    }
    const arrived = !node.healthy
    node.maxReplicas = beat.maxReplicas
    node.compatibility = beat.compatibility
    node.lastSeen = performance.now()
    node.healthy = true
    const reported = new Set(beat.workers.map(worker => worker.id))
    for (const [id, record] of [...node.workers]) if (!reported.has(id) && beat.generation >= record.generation) record.lose()
    if (arrived) queueMicrotask(() => this.onNodeReady())
    return beat.workers.filter(worker => !node.workers.has(worker.id) && !node.pending.has(worker.id)).map(worker => worker.id)
  }

  /** Heartbeat loss removes the node's replicas from routing. It does not prove those processes stopped. */
  private expire() {
    const now = performance.now()
    for (const node of this.nodes.values()) {
      if (!node.healthy || now - node.lastSeen <= this.heartbeatTimeoutMs) continue
      node.healthy = false
      for (const record of [...node.workers.values()]) record.lose()
    }
  }
}
