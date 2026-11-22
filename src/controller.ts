import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MonoripperError, type AppDefinition, type Ownership, type RuntimeOptions } from './definitions'
import { assertKeys } from './config'
import { owns, validateApp } from './ownership'
import { publicOperation, type ControlError, type ControlStatus, type OperationStep, type SetContextRequest, type StoredOperation } from './control-types'
import type { StateStore } from './state-store'
import type { WorkerPool } from './worker-pool'
import type { WorkerSource } from './process-worker'
import type { ReleaseCache } from './release-cache'

/** Source mode runs one resolved app from a checkout; release mode runs extracted releases from the cache. */
export type ControllerSource = { kind: 'source'; app: AppDefinition; root: string } | { kind: 'release'; cache: ReleaseCache; workRoot: string }
const active = (operation: StoredOperation) => operation.phase === 'accepted' || operation.phase === 'applying'
const digestRule = /^sha256:[a-f0-9]{64}$/
const contextRule = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export class Controller {
  private jobs: Promise<unknown> = Promise.resolve()
  private closing = false
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private restarts = new Map<string, number>()
  private errors = new Map<string, ControlError>()
  private closePromise?: Promise<void>
  /** Ownership of each context's serving release; the gateway reads it on every request. */
  private routing = new Map<string, Ownership[]>()
  constructor(readonly store: StateStore, readonly pool: WorkerPool, private options: RuntimeOptions, private source: ControllerSource) {}

  get releaseMode() { return this.source.kind === 'release' }

  async initialize() {
    const snapshot = this.store.read()
    for (const context of Object.keys(snapshot.desired)) this.routing.set(context, await this.ownership(context, snapshot.serving[context] ?? snapshot.releases[context]))
    for (const [context, count] of Object.entries(snapshot.desired)) {
      const pending = snapshot.operations.find(operation => operation.context === context && active(operation))
      if (pending) {
        await this.enqueue(() => this.apply(pending.id))
        // Replayed growth can roll back desired state without any old processes still alive.
        const after = this.store.read()
        if (Object.hasOwn(after.desired, context)) await this.pool.scale(context, after.desired[context]!, await this.workerSource(context))
      } else await this.pool.scale(context, count, await this.workerSource(context))
    }
  }

  /** The context owning a request, from the serving routing table. */
  owner(method: string, path: string): string | undefined {
    for (const [context, rules] of this.routing) if (owns(rules, method, path)) return context
    return undefined
  }

  status(): ControlStatus {
    const state = this.store.read()
    return { project: state.project, environment: state.environment, revision: state.revision, persistent: this.store.persistent,
      healthy: !this.closing && this.store.healthy && Object.entries(state.desired).every(([name, count]) => this.pool.ready(name).length >= count), workers: this.pool.status(),
      contexts: Object.entries(state.desired).map(([name, desiredReplicas]) => ({
        name, desiredReplicas, readyReplicas: this.pool.ready(name).length, restarts: this.restarts.get(name) ?? 0,
        ...(this.errors.has(name) ? { error: this.errors.get(name)! } : {}),
        ...(state.releases[name] ? { release: state.releases[name] } : {}),
        ...(state.serving[name] ? { servingRelease: state.serving[name] } : {}),
        ...(state.lastGood[name] ? { lastGoodRelease: state.lastGood[name] } : {}),
        ...(state.autoscale[name] ? { autoscale: structuredClone(state.autoscale[name]) } : {}),
      })) }
  }
  operation(id: string) {
    const operation = this.store.read().operations.find(operation => operation.id === id)
    if (!operation) throw new MonoripperError('NOT_FOUND', 'Operation not found')
    return publicOperation(operation)
  }

  async set(input: SetContextRequest, origin: 'operator' | 'autoscaler' = 'operator') {
    assertKeys(input, ['project', 'environment', 'requestId', 'expectedRevision', 'context', 'replicas', 'release'], 'SetContext')
    if (this.closing) throw new MonoripperError('SHUTTING_DOWN', 'Controller is shutting down')
    const state = this.store.read()
    if (input.project !== state.project || input.environment !== state.environment) throw new MonoripperError('PERMISSION_DENIED', 'Wrong project or environment')
    const known = typeof input.context === 'string' && Object.hasOwn(state.desired, input.context)
    if (typeof input.requestId !== 'string' || !/^[\w.:-]{1,128}$/.test(input.requestId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision > 0xffffffff
      || (input.replicas !== undefined && (!Number.isSafeInteger(input.replicas) || input.replicas < 0 || input.replicas > 64))
      || typeof input.context !== 'string' || !contextRule.test(input.context)
      || (input.release !== undefined && (typeof input.release !== 'string' || !digestRule.test(input.release)))
      || (input.release === undefined && (!known || input.replicas === undefined))) throw new MonoripperError('INVALID_ARGUMENT', 'Invalid SetContext request')
    if (input.release !== undefined && !this.releaseMode) throw new MonoripperError('RELEASES_DISABLED', 'This runtime serves a source app; start it from a release to deploy digests')
    // A deployment's idempotency key is its intent, so a CI retry that re-read the revision still finds the original operation.
    const payload = input.release === undefined
      ? [input.project, input.environment, input.context, input.replicas, input.expectedRevision, ...(origin === 'autoscaler' ? [origin] : [])]
      : [input.project, input.environment, input.context, input.replicas ?? null, input.release, origin]
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    const operation = await this.store.update(next => {
      if (this.closing) throw new MonoripperError('SHUTTING_DOWN', 'Controller is shutting down')
      const previous = next.operations.find(operation => operation.requestId === input.requestId)
      if (previous) {
        if (previous.payloadHash !== payloadHash) throw new MonoripperError('ALREADY_EXISTS', 'requestId was used with another payload')
        return previous
      }
      if (next.revision !== input.expectedRevision) throw new MonoripperError('CONFLICT', 'State revision changed; read status before retrying')
      if (next.operations.some(operation => operation.context === input.context && active(operation))) throw new MonoripperError('BUSY', 'Context already has an active operation')
      const current = next.desired[input.context]
      const replicas = input.replicas ?? current ?? 1
      if (origin === 'operator' && next.autoscale[input.context] && replicas !== current) {
        throw new MonoripperError('AUTOSCALE_ACTIVE', 'Autoscaling manages this context; disable its policy before changing replicas manually')
      }
      // ponytail: retain up to 10000 durable idempotency records; add explicit archival before increasing this ceiling.
      const pending = next.operations.filter(active).length
      if (next.operations.length >= 10000 || next.revision >= 0xffffffff - pending - 1) throw new MonoripperError('CAPACITY_EXCEEDED', 'Controller history/revision limit reached')
      const total = Object.entries(next.desired).reduce((sum, [name, count]) => sum + (name === input.context ? 0 : count), replicas)
      if (total > 64) throw new MonoripperError('CAPACITY_EXCEEDED', 'Prototype limit: 64 total replicas')
      const created: StoredOperation = { id: randomUUID(), requestId: input.requestId, context: input.context, replicas,
        ...(input.release ? { release: input.release } : {}), previousReplicas: current ?? 0,
        ...(next.releases[input.context] ? { previousRelease: next.releases[input.context] } : {}),
        payloadHash, revision: ++next.revision, phase: 'accepted', createdAt: Date.now(), updatedAt: Date.now(), ...(origin === 'autoscaler' ? { origin } : {}) }
      next.desired[input.context] = replicas
      if (input.release) next.releases[input.context] = input.release
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
  /** Serializes all lifecycle changes, including autoscaler decisions. */
  enqueue<T>(run: () => Promise<T>): Promise<T> {
    const work = this.jobs.then(run)
    this.jobs = work.catch(() => {})
    return work
  }

  private async ownership(context: string, release?: string): Promise<Ownership[]> {
    if (this.source.kind === 'source') return structuredClone(this.source.app.contexts[context]!.owns)
    const loaded = await this.source.cache.ensure(this.store.read().project, release!)
    const spec = loaded.manifest.contexts[context]
    if (!spec) throw new MonoripperError('RELEASE_CONTEXT_MISSING', `Release ${release} does not declare context ${context}`)
    return structuredClone(spec.owns)
  }
  private async workerSource(context: string, release = this.store.read().releases[context]): Promise<WorkerSource> {
    if (this.source.kind === 'source') return { app: this.source.app, cwd: this.source.root }
    const loaded = await this.source.cache.ensure(this.store.read().project, release!)
    if (!loaded.manifest.contexts[context]) throw new MonoripperError('RELEASE_CONTEXT_MISSING', `Release ${release} does not declare context ${context}`)
    const cwd = join(this.source.workRoot, context)
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    return { app: loaded.app, cwd, release }
  }
  private async step(id: string, step: OperationStep) {
    await this.store.update(next => { const op = next.operations.find(op => op.id === id)!; op.step = step; op.updatedAt = Math.max(Date.now(), op.createdAt) })
  }
  private assertRoutable(context: string, rules: Ownership[]) {
    const contexts = Object.fromEntries([...this.routing].filter(([name]) => name !== context).map(([name, owned]) => [name, { entry: name, owns: owned }]))
    contexts[context] = { entry: context, owns: rules }
    validateApp({ project: this.store.read().project, contexts })
  }

  /**
   * Prepares the complete new serving set, then switches routing and replicas in one synchronous step.
   * Returns false when shutdown interrupted it before the switch; the operation then stays pending for replay.
   */
  private async deploy(operation: StoredOperation): Promise<{ switched: boolean; warning?: ControlError }> {
    await this.step(operation.id, 'preparing')
    const rules = await this.ownership(operation.context, operation.release)
    this.assertRoutable(operation.context, rules)
    const source = await this.workerSource(operation.context, operation.release)
    await this.step(operation.id, 'starting')
    const candidates = await this.pool.startCandidates(operation.context, operation.replicas, source)
    if (this.closing) { await this.pool.stopCandidates(candidates); return { switched: false } }
    await this.step(operation.id, 'switching')
    this.assertRoutable(operation.context, rules)
    const previous = this.pool.switchTo(operation.context, candidates)
    this.routing.set(operation.context, rules)
    if (process.env.MONORIPPER_FAILPOINT === 'deploy-after-switch') process.kill(process.pid, 'SIGKILL') // Test hook: crash before persisting the switch.
    await this.store.update(next => {
      next.serving[operation.context] = operation.release!
      const op = next.operations.find(op => op.id === operation.id)!; op.step = 'draining'; op.updatedAt = Math.max(Date.now(), op.createdAt)
    })
    try { await this.pool.drainAll(previous) } catch (error) {
      return { switched: true, warning: { code: error instanceof MonoripperError ? error.code : 'DRAIN_FAILED', message: 'Previous replicas did not drain cleanly' } }
    }
    return { switched: true }
  }

  private async apply(id: string) {
    const operation = this.store.read().operations.find(operation => operation.id === id)!
    if (this.closing || !this.store.healthy || !active(operation)) return
    await this.store.update(next => { const op = next.operations.find(op => op.id === id)!; op.phase = 'applying'; op.updatedAt = Math.max(Date.now(), op.createdAt) })
    this.restarts.set(operation.context, 0)
    let switched = false
    try {
      let warning: ControlError | undefined
      const state = this.store.read()
      const deploying = operation.release !== undefined && (state.serving[operation.context] !== operation.release
        || this.pool.ready(operation.context).some(worker => worker.release !== operation.release) || !this.routing.has(operation.context))
      if (deploying) {
        const result = await this.deploy(operation)
        switched = result.switched
        if (!switched) return
        warning = result.warning
      } else await this.pool.scale(operation.context, operation.replicas, await this.workerSource(operation.context))
      if (this.closing && !switched) return // Keep pending desired state for replay, rather than cancelling an accepted mutation.
      await this.store.update(next => {
        const op = next.operations.find(op => op.id === id)!
        op.phase = 'succeeded'; delete op.step; op.updatedAt = Math.max(Date.now(), op.createdAt)
        if (warning) op.warning = warning
        if (op.release) { next.serving[op.context] = op.release; next.lastGood[op.context] = op.release }
      })
      this.errors.delete(operation.context)
    } catch (error) {
      if (this.closing && !switched) return
      const failure = { code: error instanceof MonoripperError ? error.code : 'APPLY_FAILED', message: 'Context did not complete the requested lifecycle change' }
      await this.store.update(next => {
        const op = next.operations.find(op => op.id === id)!
        op.phase = 'failed'; op.error = failure; delete op.step; op.updatedAt = Math.max(Date.now(), op.createdAt)
        if (op.release && !switched) {
          // Nothing switched: the previous release and count keep serving. A new context disappears again.
          if (op.previousRelease) { next.desired[op.context] = op.previousReplicas; next.releases[op.context] = op.previousRelease }
          else for (const map of [next.desired, next.releases, next.serving, next.lastGood, next.autoscale]) delete map[op.context]
          next.revision++
        } else if (!op.release && op.replicas > op.previousReplicas) { next.desired[op.context] = op.previousReplicas; next.revision++ }
      })
      if (operation.release && !switched && !operation.previousRelease) this.routing.delete(operation.context)
      this.errors.set(operation.context, failure)
    }
  }
  private async recover(context: string) {
    if (this.closing || !this.store.healthy) return
    const state = this.store.read()
    if (!Object.hasOwn(state.desired, context)) return
    const target = state.desired[context]!
    if (this.pool.ready(context).length >= target) { this.errors.delete(context); return }
    if (state.operations.some(operation => operation.context === context && active(operation))) return
    const count = this.restarts.get(context) ?? 0
    if (count >= (this.options.recovery?.maxRestarts ?? 3)) {
      this.errors.set(context, { code: 'RESTART_BUDGET_EXHAUSTED', message: 'Worker restart budget exhausted; apply an explicit operator change to retry' })
      return
    }
    this.restarts.set(context, count + 1)
    try { await this.pool.scale(context, target, await this.workerSource(context)); this.errors.delete(context) }
    catch { this.unexpectedExit(context) }
  }
}
