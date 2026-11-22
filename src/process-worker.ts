import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { MonoripperError, type AppDefinition, type RuntimeOptions } from './definitions'
import type { WorkerSpec } from './worker'
import { logEvent, pipeLines, workerLine } from './log'

/** What a worker runs: the resolved app (source checkout or extracted release) and its working directory. */
export interface WorkerSource {
  app: AppDefinition; cwd: string; release?: string
  /** Loopback URL of the listener that serves this worker's `services.fetch` calls. */
  services?: string
  /** Runtime a release was built for; node agents must match it. */
  compatibility?: import('./release').ReleaseCompatibility
}
/** How the gateway reaches a replica: its loopback port, or a node agent over HTTPS that proxies to it. */
export interface Endpoint { hostname: string; port: number; tls?: { ca?: string; serverName?: string }; headers: Record<string, string> }
export interface ManagedWorker {
  context: string; pid: number; port: number; token: string; release?: string
  /** `local` for this process's children; otherwise the node agent id. */
  node: string; id: string; endpoint: Endpoint
  /** Credential the worker presents with `services.fetch`. */
  servicesToken: string
  exited: boolean; draining: boolean; published: boolean; inFlight: number
  /** Relayed WebSockets; drain asks each to close with 1001 and waits until the set is empty. */
  sockets: Set<{ goAway(): void }>
  stop(timeoutMs?: number): Promise<void>
  kill(): Promise<void>
}
export function websocketLimits(options: RuntimeOptions) {
  const ws = options.http?.websocket
  const maxMessageBytes = ws?.maxMessageBytes ?? 1024 * 1024
  return { maxMessageBytes, maxConnections: ws?.maxConnections ?? 1024, idleTimeoutSeconds: ws?.idleTimeoutSeconds ?? 120,
    maxBufferedBytes: ws?.maxBufferedBytes ?? Math.min(maxMessageBytes * 4, 0x7fffffff) }
}
export async function startWorker(context: string, source: WorkerSource, options: RuntimeOptions,
  onExit: (worker: ManagedWorker) => void, signal: AbortSignal): Promise<ManagedWorker> {
  const token = randomBytes(32).toString('hex')
  const servicesToken = randomBytes(32).toString('hex')
  const startupTimeout = options.lifecycle?.startupTimeoutMs ?? 15_000
  const shutdownTimeout = options.lifecycle?.shutdownTimeoutMs ?? 10_000
  let failMessage: string | undefined
  let readyResolve!: (port: number) => void, readyReject!: (error: Error) => void
  const ready = new Promise<number>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const script = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url))
  const env = { ...process.env, ...options.env }
  if (options.control) env[options.control.tokenEnv] = '' // Do not pass the administrative credential to application workers/dotenv.
  for (const name of [options.cluster?.tokenEnv, options.registry?.tokenEnv]) if (name) env[name] = ''
  if (source.services) { env.MONORIPPER_SERVICES_URL = source.services; env.MONORIPPER_SERVICES_TOKEN = servicesToken }
  else { delete env.MONORIPPER_SERVICES_URL; delete env.MONORIPPER_SERVICES_TOKEN }
  const format = options.logging?.format ?? 'text'
  const output = format === 'json' ? 'pipe' : 'inherit'
  const app = source.app
  const child = Bun.spawn([process.execPath, script], {
    cwd: source.cwd, env, stdout: output, stderr: output,
    ipc(message) {
      if (!message || typeof message !== 'object') return
      if (message.type === 'diagnostic' && typeof message.code === 'string' && typeof message.message === 'string') {
        try { options.onDiagnostic?.({ context, code: message.code, message: message.message }) }
        catch { console.error('[monoripper] Diagnostic sink failed') }
        if (!options.onDiagnostic) {
          if (format === 'json') logEvent(format, 'error', { event: 'diagnostic', context, worker: child.pid, code: message.code })
          else console.error(`[monoripper] ${context}: ${message.code}`)
        }
      }
      if (message.type === 'failed' && typeof message.message === 'string') {
        failMessage = message.message
        readyReject(new MonoripperError('CONTEXT_START_FAILED', `${context}: ${failMessage}`))
      }
      if (message.type === 'ready' && message.token === token && message.pid === child.pid
        && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) readyResolve(message.port)
    },
  })
  if (format === 'json') {
    for (const [stream, target] of [['stdout', process.stdout], ['stderr', process.stderr]] as const) {
      const piped = child[stream]
      if (piped instanceof ReadableStream) void pipeLines(piped, (line, truncated) => { target.write(workerLine(line, context, child.pid, stream, truncated) + '\n') })
    }
  }
  const worker: ManagedWorker = { context, pid: child.pid, port: 0, token, ...(source.release ? { release: source.release } : {}),
    node: 'local', id: randomBytes(16).toString('hex'), endpoint: { hostname: '127.0.0.1', port: 0, headers: { 'x-monoripper-token': token } }, servicesToken, exited: false, draining: false, published: false, inFlight: 0, sockets: new Set(),
    stop, async kill() { if (!worker.exited) child.kill('SIGKILL'); await exit } }
  const exit = child.exited.then(code => {
    worker.exited = true
    logEvent(format, worker.published && !worker.draining ? 'error' : 'info', { event: 'worker_exited', context, worker: child.pid, exitCode: code })
    readyReject(new MonoripperError('CONTEXT_START_FAILED', `${context} exited (${code})${failMessage ? ': ' + failMessage : ''}`))
    onExit(worker)
    return code
  })
  let stopPromise: Promise<void> | undefined
  function stop(timeoutMs = shutdownTimeout): Promise<void> {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      if (worker.exited) return
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        try { child.send({ type: 'stop' }) } catch { child.kill('SIGTERM') }
        const result = await Promise.race([exit, new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })])
        if (result === 'timeout') { await worker.kill(); throw new MonoripperError('SHUTDOWN_TIMEOUT', `${context} exceeded shutdown timeout`) }
        if (result !== 0) throw new MonoripperError('CONTEXT_STOP_FAILED', `${context}: ${failMessage ?? `exit ${result}`}`)
      } finally { if (timer) clearTimeout(timer) }
    })()
    return stopPromise
  }
  const aborted = () => readyReject(new MonoripperError('SHUTTING_DOWN', 'Worker startup cancelled during shutdown'))
  signal.addEventListener('abort', aborted, { once: true })
  const timer = setTimeout(() => readyReject(new MonoripperError('STARTUP_TIMEOUT', `${context} exceeded startup timeout`)), startupTimeout)
  const startedAt = performance.now()
  try {
    if (signal.aborted) aborted()
    const spec: WorkerSpec = { context, app, token, shutdownTimeoutMs: shutdownTimeout, maxRequestBodyBytes: options.http?.maxRequestBodyBytes ?? 16 * 1024 * 1024,
      websocket: websocketLimits(options) }
    child.send({ type: 'start', spec })
    worker.port = await ready
    worker.endpoint.port = worker.port
    const remaining = Math.max(1, Math.ceil(startupTimeout - (performance.now() - startedAt)))
    const response = await fetch(`http://127.0.0.1:${worker.port}/`, {
      headers: { 'x-monoripper-token': token, 'x-monoripper-probe': '1' }, signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]), proxy: '',
    })
    if (response.status !== 204 || worker.exited) throw new MonoripperError('CONTEXT_START_FAILED', `${context} failed readiness probe`)
    logEvent(format, 'info', { event: 'worker_ready', context, worker: child.pid })
    return worker
  } catch (error) {
    try { await stop() } catch (cleanupError) {
      if (signal.aborted) throw cleanupError // A cancelled startup must not disguise failed cleanup as a clean stop.
      // Preserve the original startup error after the process has exited.
    }
    throw error
  } finally { clearTimeout(timer); signal.removeEventListener('abort', aborted) }
}
