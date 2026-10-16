import { resolve } from 'node:path'
import { MonoripperError, type AppDefinition, type ServeOptions } from './definitions'
import { forwardingHeaders, leasedBody, publicError } from './http'
import { owns, validPath, validateApp } from './ownership'
import { assertKeys, validateRuntimeConfig } from './config'
import { WorkerPool } from './worker-pool'
import { StateStore } from './state-store'
import { Controller } from './controller'
import type { ControlStatus, Operation, SetContextRequest, WorkerStatus } from './control-types'

export interface Runtime {
  readonly url: URL
  readonly controlAddress?: string
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
  assertKeys(options, ['app', 'root', 'initial', 'http', 'lifecycle', 'env', 'onDiagnostic', 'control', 'dataDir', 'environment', 'recovery', 'startupSignal'], 'serve')
  validateRuntimeConfig(options)
  validateApp(options.app)
  if (options.startupSignal !== undefined && !(options.startupSignal instanceof AbortSignal)) throw new MonoripperError('INVALID_CONFIG', 'startupSignal must be an AbortSignal')
  const assertStarting = () => { if (options.startupSignal?.aborted) throw new MonoripperError('SHUTTING_DOWN', 'Runtime startup cancelled') }
  assertStarting()
  if (options.root !== undefined && typeof options.root !== 'string') throw new MonoripperError('INVALID_CONFIG', 'root must be a path')
  if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== 'function') throw new MonoripperError('INVALID_CONFIG', 'onDiagnostic must be a function')
  options = { ...options, app: structuredClone(options.app), initial: structuredClone(options.initial),
    http: { ...options.http }, lifecycle: { ...options.lifecycle }, recovery: { ...options.recovery },
    ...(options.control ? { control: { ...options.control } } : {}), env: { ...options.env } }
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
  let server: ReturnType<typeof Bun.serve> | undefined
  let control: { address: string; close(): void } | undefined
  let stopping = false
  let stopPromise: Promise<void> | undefined
  const counters = new Map<string, number>()
  const requestTimeout = options.lifecycle?.requestTimeoutMs ?? 30_000
  const cancelStartup = () => controller.beginClose()
  options.startupSignal?.addEventListener('abort', cancelStartup, { once: true })
  try {
    assertStarting()
    await controller.initialize()
    assertStarting()
    server = Bun.serve({
      hostname: options.http?.host ?? '127.0.0.1', port: options.http?.port ?? 3000,
      maxRequestBodySize: options.http?.maxRequestBodyBytes ?? 16 * 1024 * 1024, idleTimeout: 30,
      async fetch(request) {
        if (stopping) return publicError(503, 'SHUTTING_DOWN')
        if (request.headers.has('upgrade')) return publicError(501, 'UPGRADE_NOT_SUPPORTED')
        const url = new URL(request.url)
        if (!validPath(url.pathname)) return publicError(400, 'INVALID_PATH')
        // ponytail: linear lookups for small apps; index immutable routing snapshots if profiling warrants it.
        const owner = Object.entries(app.contexts).find(([, context]) => owns(context.owns, request.method, url.pathname))?.[0]
        if (!owner) return publicError(404, 'NOT_FOUND')
        const ready = pool.ready(owner)
        if (!ready.length) return publicError(503, 'CONTEXT_UNAVAILABLE')
        const counter = counters.get(owner) ?? 0
        counters.set(owner, (counter + 1) % ready.length)
        const worker = ready[counter % ready.length]!
        url.protocol = 'http:'; url.hostname = '127.0.0.1'; url.port = String(worker.port)
        const headers = forwardingHeaders(request.headers, true)
        headers.set('x-monoripper-token', worker.token)
        const deadline = AbortSignal.timeout(requestTimeout)
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
          return publicError(deadline.aborted ? 504 : 502, deadline.aborted ? 'DEADLINE_EXCEEDED' : 'UPSTREAM_ERROR')
        }
      },
      error() { return publicError(500, 'INTERNAL_ERROR') },
    })
    if (options.control) {
      const { startControlServer } = await import('./grpc-server')
      control = await startControlServer(controller, options.control, token!)
    }
    assertStarting()
    const gateway = server
    return {
      url: new URL(gateway.url), ...(control ? { controlAddress: control.address } : {}),
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
        stopPromise = (async () => {
          const closed = gateway.stop(false)
          try { await controller.close() } finally { await gateway.stop(true); await closed }
        })()
        return stopPromise
      },
    }
  } catch (error) {
    control?.close()
    await server?.stop(true)
    try { await controller.close() } catch (cleanupError) {
      if (error instanceof MonoripperError && error.code === 'SHUTTING_DOWN') throw cleanupError
      // Preserve startup failure; close always releases its writer lock.
    }
    throw error
  } finally { options.startupSignal?.removeEventListener('abort', cancelStartup) }
}
