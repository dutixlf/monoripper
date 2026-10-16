import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { MonoripperError, type AppDefinition, type ServeOptions } from './definitions'
import { forwardingHeaders, publicError } from './http'
import { owns, validPath, validateApp } from './ownership'
import { assertKeys, validateRuntimeConfig } from './config'
import type { WorkerSpec } from './worker'

interface Worker {
  context: string
  pid: number
  port: number
  token: string
  exited: boolean
  stop(): Promise<void>
}
export interface Runtime {
  readonly url: URL
  status(): { context: string; pid: number; ready: boolean }[]
  stop(): Promise<void>
}

function resolveApp(app: AppDefinition, root: string): AppDefinition {
  return {
    ...app,
    contexts: Object.fromEntries(Object.entries(app.contexts).map(([name, context]) => [name, {
      ...context, entry: resolve(root, context.entry), root: context.root ? resolve(root, context.root) : undefined,
    }])),
    resources: Object.fromEntries(Object.entries(app.resources ?? {}).map(([name, resource]) => [name, {
      ...resource, entry: resolve(root, resource.entry),
    }])),
    tsconfig: app.tsconfig ? resolve(root, app.tsconfig) : undefined,
  }
}

async function startWorker(context: string, app: AppDefinition, options: ServeOptions): Promise<Worker> {
  const token = randomBytes(32).toString('hex')
  const startupTimeout = options.lifecycle?.startupTimeoutMs ?? 15_000
  const shutdownTimeout = options.lifecycle?.shutdownTimeoutMs ?? 10_000
  let failMessage: string | undefined
  let readyResolve!: (port: number) => void
  let readyReject!: (error: Error) => void
  const ready = new Promise<number>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const script = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url))
  const child = Bun.spawn([process.execPath, script], {
    cwd: resolve(options.root ?? process.cwd()),
    env: { ...process.env, ...options.env },
    stdout: 'inherit', stderr: 'inherit',
    ipc(message) {
      if (!message || typeof message !== 'object') return
      if (message.type === 'diagnostic' && typeof message.code === 'string' && typeof message.message === 'string') {
        if (options.onDiagnostic) {
          try { options.onDiagnostic({ context, code: message.code, message: message.message }) }
          catch { console.error('[monoripper] Diagnostic sink failed') }
        } else console.error(`[monoripper] ${context}: ${message.code}`)
      }
      if (message.type === 'failed' && typeof message.message === 'string') {
        failMessage = message.message
        readyReject(new MonoripperError('CONTEXT_START_FAILED', `${context}: ${failMessage}`))
      }
      if (message.type === 'ready' && message.token === token && message.pid === child.pid
        && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) readyResolve(message.port)
    },
  })
  const worker: Worker = { context, pid: child.pid, port: 0, token, exited: false, stop }
  const exit = child.exited.then(code => {
    worker.exited = true
    readyReject(new MonoripperError('CONTEXT_START_FAILED', `${context} exited before ready (${code})${failMessage ? ': ' + failMessage : ''}`))
    return code
  })
  let stopPromise: Promise<void> | undefined
  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      if (worker.exited) return
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        try { child.send({ type: 'stop' }) } catch { child.kill('SIGTERM') }
        const result = await Promise.race([
          exit,
          new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), shutdownTimeout) }),
        ])
        if (result === 'timeout') {
          child.kill('SIGKILL')
          await exit
          throw new MonoripperError('SHUTDOWN_TIMEOUT', `${context} exceeded shutdown timeout`)
        }
        if (result !== 0) throw new MonoripperError('CONTEXT_STOP_FAILED', `${context}: ${failMessage ?? `exit ${result}`}`)
      } finally { if (timer) clearTimeout(timer) }
    })()
    return stopPromise
  }
  const timer = setTimeout(() => readyReject(new MonoripperError('STARTUP_TIMEOUT', `${context} exceeded startup timeout`)), startupTimeout)
  try {
    const spec: WorkerSpec = { context, app, token, maxRequestBodyBytes: options.http?.maxRequestBodyBytes ?? 16 * 1024 * 1024 }
    child.send({ type: 'start', spec })
    worker.port = await ready
    const response = await fetch(`http://127.0.0.1:${worker.port}/`, {
      headers: { 'x-monoripper-token': token, 'x-monoripper-probe': '1' },
      signal: AbortSignal.timeout(startupTimeout),
      proxy: '',
    })
    if (response.status !== 204) throw new MonoripperError('CONTEXT_START_FAILED', `${context} failed readiness probe`)
    return worker
  } catch (error) {
    try { await stop() } catch { /* Preserve the original startup error; stop already waited/killed the process. */ }
    throw error
  } finally { clearTimeout(timer) }
}

export async function serve(options: ServeOptions): Promise<Runtime> {
  assertKeys(options, ['app', 'root', 'initial', 'http', 'lifecycle', 'env', 'onDiagnostic'], 'serve')
  validateRuntimeConfig(options)
  validateApp(options.app)
  if (options.root !== undefined && typeof options.root !== 'string') throw new MonoripperError('INVALID_CONFIG', 'root must be a path')
  if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== 'function') throw new MonoripperError('INVALID_CONFIG', 'onDiagnostic must be a function')
  options = { ...options, app: structuredClone(options.app), initial: structuredClone(options.initial),
    http: { ...options.http }, lifecycle: { ...options.lifecycle }, env: { ...options.env } }
  const root = resolve(options.root ?? process.cwd())
  const app = resolveApp(options.app, root)
  const port = options.http?.port ?? 3000
  for (const name of Object.keys(options.initial)) {
    if (!Object.hasOwn(app.contexts, name)) throw new MonoripperError('INVALID_CONFIG', `Unknown initial context: ${name}`)
  }
  const workers: Worker[] = []
  let server: ReturnType<typeof Bun.serve> | undefined
  let stopPromise: Promise<void> | undefined
  let stopping = false
  const counters = new Map<string, number>()
  const requestTimeout = options.lifecycle?.requestTimeoutMs ?? 30_000
  try {
    for (const [name, selected] of Object.entries(options.initial)) {
      for (let i = 0; i < selected.replicas; i++) workers.push(await startWorker(name, app, { ...options, root }))
    }
    server = Bun.serve({
      hostname: options.http?.host ?? '127.0.0.1', port,
      maxRequestBodySize: options.http?.maxRequestBodyBytes ?? 16 * 1024 * 1024,
      idleTimeout: 30,
      async fetch(request) {
        if (stopping) return publicError(503, 'SHUTTING_DOWN')
        if (request.headers.has('upgrade')) return publicError(501, 'UPGRADE_NOT_SUPPORTED')
        const url = new URL(request.url)
        if (!validPath(url.pathname)) return publicError(400, 'INVALID_PATH')
        // ponytail: linear lookup for small apps; index routing snapshots if profiling warrants it.
        const owner = Object.entries(app.contexts).find(([, context]) => owns(context.owns, request.method, url.pathname))?.[0]
        if (!owner) return publicError(404, 'NOT_FOUND')
        const ready = workers.filter(worker => worker.context === owner && !worker.exited)
        if (!ready.length) return publicError(503, 'CONTEXT_UNAVAILABLE')
        const counter = counters.get(owner) ?? 0
        counters.set(owner, (counter + 1) % ready.length)
        const worker = ready[counter % ready.length]!
        url.protocol = 'http:'
        url.hostname = '127.0.0.1'
        url.port = String(worker.port)
        const headers = forwardingHeaders(request.headers, true)
        headers.set('x-monoripper-token', worker.token)
        const deadline = AbortSignal.timeout(requestTimeout)
        try {
          const response = await fetch(url, {
            method: request.method, headers,
            body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
            signal: AbortSignal.any([request.signal, deadline]),
            redirect: 'manual', decompress: false, proxy: '',
          })
          return new Response(response.body, {
            status: response.status, statusText: response.statusText,
            headers: forwardingHeaders(response.headers),
          })
        } catch {
          return publicError(deadline.aborted ? 504 : 502, deadline.aborted ? 'DEADLINE_EXCEEDED' : 'UPSTREAM_ERROR')
        }
      },
      error() { return publicError(500, 'INTERNAL_ERROR') },
    })
    const gateway = server
    return {
      url: new URL(gateway.url),
      status: () => workers.map(worker => ({ context: worker.context, pid: worker.pid, ready: !worker.exited && !stopping })),
      stop() {
        if (stopPromise) return stopPromise
        stopping = true
        stopPromise = (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = options.lifecycle?.shutdownTimeoutMs ?? 10_000
          try {
            // Stop new ingress before draining workers. Worker stop waits for Elysia's server body lifetime.
            const gatewayClosed = gateway.stop(false)
            const results = await Promise.allSettled(workers.map(worker => worker.stop()))
            await Promise.race([gatewayClosed, new Promise<void>(resolve => { timer = setTimeout(resolve, timeout) })])
            await gateway.stop(true)
            const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            if (errors.length) throw new AggregateError(errors.map(error => error.reason), 'One or more contexts failed to stop')
          } finally { if (timer) clearTimeout(timer) }
        })()
        return stopPromise
      },
    }
  } catch (error) {
    await server?.stop(true)
    await Promise.allSettled(workers.map(worker => worker.stop()))
    throw error
  }
}
