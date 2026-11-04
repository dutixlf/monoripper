import { Elysia, type AnyElysia } from 'elysia'
import { pathToFileURL } from 'node:url'
import type { AppDefinition, ContextDefinition, ResourceDefinition } from './definitions'
import { ownsRoute } from './ownership'

export interface WorkerSpec {
  context: string
  app: AppDefinition
  token: string
  maxRequestBodyBytes: number
  shutdownTimeoutMs?: number
}

let app: AnyElysia | undefined
let context: ContextDefinition | undefined
const resources: { definition: ResourceDefinition<unknown>; value: unknown }[] = []
let stopHooks: NonNullable<AnyElysia['event']['stop']> = []
let stopping = false
let started = false
let disconnectTimeoutMs = 10_000
let stopPromise: Promise<void> | undefined
const lifetime = new AbortController()
const send = (message: object) => { if (process.connected) process.send?.(message) }
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

async function cleanup(): Promise<void> {
  if (stopPromise) return stopPromise
  stopping = true
  lifetime.abort()
  stopPromise = (async () => {
    const errors: unknown[] = []
    const attempt = async (action: () => unknown) => { try { await action() } catch (error) { errors.push(error) } }
    if (app?.server) await attempt(() => app!.stop())
    for (const hook of stopHooks) await attempt(() => hook.fn(app!))
    if (context?.stop) await attempt(() => context!.stop!())
    for (const item of resources.toReversed()) if (item.definition.stop) await attempt(() => item.definition.stop!(item.value))
    if (errors.length) throw new AggregateError(errors, errors.map(messageOf).join('; '))
  })()
  return stopPromise
}

async function start(spec: WorkerSpec): Promise<void> {
  disconnectTimeoutMs = spec.shutdownTimeoutMs ?? 10_000
  const declaration = spec.app.contexts[spec.context]!
  const values = new Map<string, unknown>()
  for (const name of declaration.resources ?? []) {
    const descriptor = spec.app.resources![name]!
    if (!descriptor.contexts.includes(spec.context)) throw new Error(`Resource not allowed: ${name}`)
    const definition = (await import(pathToFileURL(descriptor.entry).href)).default as ResourceDefinition<unknown>
    if (typeof definition?.start !== 'function' || (definition.stop !== undefined && typeof definition.stop !== 'function')) {
      throw new Error(`Resource ${name} must export valid start/stop functions as default`)
    }
    const value = await definition.start({ env: process.env, context: spec.context })
    resources.push({ definition, value })
    values.set(name, value)
  }
  context = (await import(pathToFileURL(declaration.entry).href)).default as ContextDefinition
  if (typeof context?.create !== 'function' || (context.stop !== undefined && typeof context.stop !== 'function')
    || (context.metrics !== undefined && typeof context.metrics !== 'function')) {
    throw new Error('Context must export valid create/stop/metrics functions as default')
  }
  const base = new Elysia().onRequest(({ request }) => {
    if (request.headers.get('x-monoripper-token') !== spec.token) return new Response('Forbidden', { status: 403 })
    if (request.headers.get('x-monoripper-metrics') === '1') return metricsResponse()
    if (stopping) return new Response('Draining', { status: 503 })
    if (request.headers.get('x-monoripper-probe') === '1') return new Response(null, { status: 204 })
  })
  app = base
  const created = await context.create({
    app: base,
    signal: lifetime.signal,
    resources: { get<T>(name: string): T {
      if (!values.has(name)) throw new Error(`Resource not initialized: ${name}`)
      return values.get(name) as T
    } },
  })
  if (created !== base) throw new Error('Context must return the provided app; compose plugins with app.use()')
  if (app.server) throw new Error('Context must not call listen(); Monoripper owns the server')
  await app.modules
  const fallback: NonNullable<AnyElysia['event']['error']>[number] = { fn: ({ code, error }) => {
    if (code === 'NOT_FOUND' || code === 'VALIDATION' || code === 'PARSE' || code === 'INVALID_COOKIE_SIGNATURE') return
    send({ type: 'diagnostic', code: 'UNHANDLED_APPLICATION_ERROR', message: messageOf(error) })
    return Response.json({ error: 'INTERNAL_ERROR' }, { status: 500 })
  } }
  for (const route of app.routes) {
    if (route.method === '$INTERNALWS' || !ownsRoute(declaration.owns, route.method, route.path)) {
      throw new Error(`Route outside ownership or unsupported: ${route.method} ${route.path}`)
    }
    route.hooks.error ??= []
    if (!route.hooks.error.includes(fallback)) route.hooks.error.push(fallback)
  }
  app.event.error ??= []
  if (!app.event.error.includes(fallback)) app.event.error.push(fallback)
  // Elysia 1.4 invokes these hooks without awaiting them. The pinned adapter takes
  // ownership so async startup failures and cleanup finish before ready/exit.
  const startHooks = [...(app.event.start ?? [])]
  stopHooks = [...(app.event.stop ?? [])]
  app.event.start = []
  app.event.stop = []
  app.listen({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: spec.maxRequestBodyBytes })
  for (const hook of startHooks) await hook.fn(app)
  if (stopping) throw new Error('Stopped during startup')
  send({ type: 'ready', token: spec.token, port: app.server!.port, pid: process.pid })
}

async function metricsResponse(): Promise<Response> {
  if (!context?.metrics) return new Response(null, { status: 204 })
  try {
    return new Response(await context.metrics(), { headers: { 'content-type': 'text/plain; version=0.0.4' } })
  } catch (error) {
    send({ type: 'diagnostic', code: 'METRICS_FAILED', message: messageOf(error) })
    return new Response(null, { status: 500 })
  }
}

async function stopAndExit(): Promise<void> {
  try {
    await cleanup()
    process.exit(0)
  } catch (error) {
    send({ type: 'failed', message: messageOf(error) })
    process.exit(1)
  }
}

process.on('message', async (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return
  if (message.type === 'stop') { await stopAndExit(); return }
  if (message.type !== 'start' || started || stopping || !('spec' in message)) return
  started = true
  try {
    await start(message.spec as WorkerSpec)
  } catch (error) {
    const errors = [messageOf(error)]
    try { await cleanup() } catch (cleanupError) { errors.push(messageOf(cleanupError)) }
    send({ type: 'failed', message: errors.join('; ') })
    process.exit(1)
  }
})
process.on('disconnect', () => {
  // A dead parent cannot enforce its deadline; do not leave orphan workers stuck in cleanup.
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), disconnectTimeoutMs).unref()
  void stopAndExit()
})
process.on('SIGTERM', () => { void stopAndExit() })
process.on('SIGINT', () => { void stopAndExit() })
