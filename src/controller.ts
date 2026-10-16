import { createHash, randomUUID } from 'node:crypto'
import { MonoripperError, type ServeOptions } from './definitions'
import { assertKeys } from './config'
import { publicOperation, type ControlError, type ControlStatus, type SetContextRequest, type StoredOperation } from './control-types'
import { StateStore } from './state-store'
import { WorkerPool } from './worker-pool'

export class Controller {
  private jobs: Promise<unknown> = Promise.resolve()
  private closing = false
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private restarts = new Map<string, number>()
  private errors = new Map<string, ControlError>()
  private closePromise?: Promise<void>
  constructor(readonly store: StateStore, readonly pool: WorkerPool, private options: ServeOptions) {}

  async initialize() {
    const snapshot = this.store.read()
    for (const [context, count] of Object.entries(snapshot.desired)) {
      const pending = snapshot.operations.find(operation => operation.context === context && ['accepted', 'applying'].includes(operation.phase))
      if (pending) await this.enqueue(() => this.apply(pending.id))
      else await this.pool.scale(context, count)
    }
  }
  status(): ControlStatus {
    const state = this.store.read()
    return { project: state.project, environment: state.environment, revision: state.revision, persistent: this.store.persistent,
      healthy: !this.closing && this.store.healthy && Object.entries(state.desired).every(([name, count]) => this.pool.ready(name).length >= count), workers: this.pool.status(), contexts: Object.entries(state.desired).map(([name, desiredReplicas]) => ({
        name, desiredReplicas, readyReplicas: this.pool.ready(name).length, restarts: this.restarts.get(name) ?? 0,
        ...(this.errors.has(name) ? { error: this.errors.get(name)! } : {}),
      })) }
  }
  operation(id: string) {
    const operation = this.store.read().operations.find(operation => operation.id === id)
    if (!operation) throw new MonoripperError('NOT_FOUND', 'Operation not found')
    return publicOperation(operation)
  }
  async set(input: SetContextRequest) {
    assertKeys(input, ['project', 'environment', 'requestId', 'expectedRevision', 'context', 'replicas'], 'SetContext')
    if (this.closing) throw new MonoripperError('SHUTTING_DOWN', 'Controller is shutting down')
    const state = this.store.read()
    if (input.project !== state.project || input.environment !== state.environment) throw new MonoripperError('PERMISSION_DENIED', 'Wrong project or environment')
    if (typeof input.requestId !== 'string' || !/^[\w.:-]{1,128}$/.test(input.requestId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision > 0xffffffff
      || !Number.isSafeInteger(input.replicas) || input.replicas < 0 || input.replicas > 64
      || typeof input.context !== 'string' || !Object.hasOwn(state.desired, input.context)) throw new MonoripperError('INVALID_ARGUMENT', 'Invalid SetContext request')
    const payloadHash = createHash('sha256').update(JSON.stringify([input.project, input.environment, input.context, input.replicas, input.expectedRevision])).digest('hex')
    const operation = await this.store.update(next => {
      if (this.closing) throw new MonoripperError('SHUTTING_DOWN', 'Controller is shutting down')
      const previous = next.operations.find(operation => operation.requestId === input.requestId)
      if (previous) {
        if (previous.payloadHash !== payloadHash) throw new MonoripperError('ALREADY_EXISTS', 'requestId was used with another payload')
        return previous
      }
      if (next.revision !== input.expectedRevision) throw new MonoripperError('CONFLICT', 'State revision changed; read status before retrying')
      if (next.operations.some(operation => operation.context === input.context && ['accepted', 'applying'].includes(operation.phase))) throw new MonoripperError('BUSY', 'Context already has an active operation')
      // ponytail: retain up to 10000 durable idempotency records; add explicit archival before increasing this ceiling.
      const pending = next.operations.filter(operation => ['accepted', 'applying'].includes(operation.phase)).length
      if (next.operations.length >= 10000 || next.revision >= 0xffffffff - pending - 1) throw new MonoripperError('CAPACITY_EXCEEDED', 'Controller history/revision limit reached')
      const total = Object.entries(next.desired).reduce((sum, [name, count]) => sum + (name === input.context ? input.replicas : count), 0)
      if (total > 64) throw new MonoripperError('CAPACITY_EXCEEDED', 'Prototype limit: 64 total replicas')
      const created: StoredOperation = { id: randomUUID(), requestId: input.requestId, context: input.context, replicas: input.replicas,
        previousReplicas: next.desired[input.context]!, payloadHash, revision: ++next.revision, phase: 'accepted', createdAt: Date.now(), updatedAt: Date.now() }
      next.desired[input.context] = input.replicas
      next.operations.push(created)
      return created
    })
    if (operation.phase === 'accepted') void this.enqueue(() => this.apply(operation.id)).catch(() => {})
    return publicOperation(operation)
  }

  unexpectedExit(context: string) {
    if (this.closing || this.timers.has(context)) return
    this.errors.set(context, { code: 'WORKER_EXITED', message: 'Worker exited; recovery scheduled' })
    const timer = setTimeout(() => {
      this.timers.delete(context)
      void this.enqueue(() => this.recover(context)).catch(() => {})
    }, this.options.recovery?.backoffMs ?? 100)
    this.timers.set(context, timer)
  }
  beginClose() {
    this.closing = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.pool.cancelStarts()
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.beginClose()
    this.closePromise = (async () => { try { await this.jobs; await this.pool.stop() } finally { await this.store.close() } })()
    return this.closePromise
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const work = this.jobs.then(run)
    this.jobs = work.catch(() => {})
    return work
  }
  private async apply(id: string) {
    const operation = this.store.read().operations.find(operation => operation.id === id)!
    if (this.closing || !this.store.healthy || !['accepted', 'applying'].includes(operation.phase)) return
    await this.store.update(next => { const op = next.operations.find(op => op.id === id)!; op.phase = 'applying'; op.updatedAt = Math.max(Date.now(), op.createdAt) })
    this.restarts.set(operation.context, 0)
    try {
      await this.pool.scale(operation.context, operation.replicas)
      if (this.closing) return // Keep pending desired state for replay, rather than cancelling an accepted mutation.
      await this.store.update(next => { const op = next.operations.find(op => op.id === id)!; op.phase = 'succeeded'; op.updatedAt = Math.max(Date.now(), op.createdAt) })
      this.errors.delete(operation.context)
    } catch (error) {
      if (this.closing) return
      const failure = { code: error instanceof MonoripperError ? error.code : 'APPLY_FAILED', message: 'Context did not complete the requested lifecycle change' }
      await this.store.update(next => {
        const op = next.operations.find(op => op.id === id)!
        op.phase = 'failed'; op.error = failure; op.updatedAt = Math.max(Date.now(), op.createdAt)
        if (op.replicas > op.previousReplicas) { next.desired[op.context] = op.previousReplicas; next.revision++ }
      })
      this.errors.set(operation.context, failure)
    }
  }
  private async recover(context: string) {
    if (this.closing || !this.store.healthy) return
    const state = this.store.read()
    const target = state.desired[context] ?? 0
    if (this.pool.ready(context).length >= target) { this.errors.delete(context); return }
    if (state.operations.some(operation => operation.context === context && ['accepted', 'applying'].includes(operation.phase))) return
    const count = this.restarts.get(context) ?? 0
    if (count >= (this.options.recovery?.maxRestarts ?? 3)) {
      this.errors.set(context, { code: 'RESTART_BUDGET_EXHAUSTED', message: 'Worker restart budget exhausted; apply an explicit operator change to retry' })
      return
    }
    this.restarts.set(context, count + 1)
    try { await this.pool.scale(context, target); this.errors.delete(context) }
    catch { this.unexpectedExit(context) }
  }
}
