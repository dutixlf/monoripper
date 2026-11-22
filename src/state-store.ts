import { constants } from 'node:fs'
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MonoripperError } from './definitions'
import { assertKeys } from './config'
import type { AutoscalePolicy, StoredOperation } from './control-types'

export interface Snapshot {
  schemaVersion: 2
  project: string
  environment: string
  revision: number
  desired: Record<string, number>
  /** Release mode: desired release digest per context. Empty in source mode. */
  releases: Record<string, string>
  /** Release each context last switched its traffic to. */
  serving: Record<string, string>
  /** Release of each context's last successful deployment. */
  lastGood: Record<string, string>
  autoscale: Record<string, AutoscalePolicy>
  operations: StoredOperation[]
}
interface Scope {
  project: string; environment: string
  /** Fixed context set of a source-mode app. Release mode leaves it open: deployments can add contexts. */
  contexts?: string[]
  initial: Record<string, number>
  /** Release mode: bootstrap release per context, applied to new state only. */
  initialReleases?: Record<string, string>
  directory?: string
}
const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const contextName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const totalReplicas = 64
const uint = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff
const invalid = (): never => { throw new MonoripperError('INVALID_STATE', 'Invalid or incompatible state snapshot; stop the runtime before repairing it') }

/** Version 1 predates releases; its fields carry over unchanged. */
function migrate(snapshot: unknown): unknown {
  if (snapshot && typeof snapshot === 'object' && (snapshot as { schemaVersion?: unknown }).schemaVersion === 1) {
    return { ...snapshot, schemaVersion: 2, releases: {}, serving: {}, lastGood: {}, autoscale: {} }
  }
  return snapshot
}

function validate(snapshot: Snapshot, scope: Scope) {
  try {
    assertKeys(snapshot, ['schemaVersion', 'project', 'environment', 'revision', 'desired', 'releases', 'serving', 'lastGood', 'autoscale', 'operations'], 'state')
    if (snapshot.schemaVersion !== 2 || snapshot.project !== scope.project || snapshot.environment !== scope.environment || !uint(snapshot.revision)) invalid()
    const names = Object.keys(snapshot.desired ?? {})
    if (scope.contexts) {
      assertKeys(snapshot.desired, scope.contexts, 'desired')
      if (scope.contexts.some(name => !Object.hasOwn(snapshot.desired, name))) invalid()
      if (Object.keys(snapshot.releases).length || Object.keys(snapshot.serving).length || Object.keys(snapshot.lastGood).length) invalid()
    } else {
      assertKeys(snapshot.desired, names, 'desired')
      if (names.some(name => !contextName.test(name) || !digest(snapshot.releases[name]))) invalid()
      assertKeys(snapshot.releases, names, 'releases')
      if (Object.keys(snapshot.releases).length !== names.length) invalid()
    }
    for (const map of [snapshot.serving, snapshot.lastGood]) {
      assertKeys(map, names, 'releases')
      if (Object.values(map).some(value => !digest(value))) invalid()
    }
    assertKeys(snapshot.autoscale, names, 'autoscale')
    for (const policy of Object.values(snapshot.autoscale)) {
      assertKeys(policy, ['min', 'max', 'targetInFlight'], 'autoscale')
      if (!uint(policy.min) || !uint(policy.max) || policy.min > policy.max || policy.max > totalReplicas || !uint(policy.targetInFlight) || policy.targetInFlight < 1) invalid()
    }
    if (Object.values(snapshot.desired).some(n => !uint(n) || n > totalReplicas) || Object.values(snapshot.desired).reduce((a, b) => a + b, 0) > totalReplicas) invalid()
    if (!Array.isArray(snapshot.operations) || snapshot.operations.length > 10000) invalid()
    const ids = new Set<string>(), requests = new Set<string>(), active = new Set<string>()
    for (const operation of snapshot.operations) {
      assertKeys(operation, ['id', 'requestId', 'context', 'replicas', 'release', 'revision', 'phase', 'step', 'createdAt', 'updatedAt', 'error', 'warning', 'origin', 'payloadHash', 'previousReplicas', 'previousRelease'], 'operation')
      if (typeof operation.id !== 'string' || !/^[a-f0-9-]{36}$/.test(operation.id) || ids.has(operation.id)) invalid()
      if (typeof operation.requestId !== 'string' || !/^[\w.:-]{1,128}$/.test(operation.requestId) || requests.has(operation.requestId)) invalid()
      if (typeof operation.context !== 'string' || !contextName.test(operation.context) || (scope.contexts && !scope.contexts.includes(operation.context)) || !uint(operation.replicas) || operation.replicas > 64 || !uint(operation.previousReplicas) || operation.previousReplicas > 64) invalid()
      if (!uint(operation.revision) || operation.revision > snapshot.revision || !['accepted', 'applying', 'succeeded', 'failed'].includes(operation.phase)) invalid()
      if (!Number.isSafeInteger(operation.createdAt) || operation.createdAt < 0 || !Number.isSafeInteger(operation.updatedAt) || operation.updatedAt < operation.createdAt) invalid()
      if (typeof operation.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(operation.payloadHash)) invalid()
      if ((operation.release !== undefined && !digest(operation.release)) || (operation.previousRelease !== undefined && !digest(operation.previousRelease))) invalid()
      if (operation.step !== undefined && !['preparing', 'starting', 'switching', 'draining'].includes(operation.step)) invalid()
      if (operation.origin !== undefined && !['operator', 'autoscaler'].includes(operation.origin)) invalid()
      if (operation.phase === 'accepted' || operation.phase === 'applying') {
        if (active.has(operation.context) || snapshot.desired[operation.context] !== operation.replicas) invalid()
        if (operation.release !== undefined && snapshot.releases[operation.context] !== operation.release) invalid()
        active.add(operation.context)
      }
      for (const failure of [operation.error, operation.warning]) {
        if (!failure) continue
        assertKeys(failure, ['code', 'message'], 'error')
        if (typeof failure.code !== 'string' || failure.code.length > 80 || typeof failure.message !== 'string' || failure.message.length > 512) invalid()
      }
      ids.add(operation.id); requests.add(operation.requestId)
    }
    if (snapshot.revision + active.size > 0xffffffff) invalid() // Reserve revisions for failed-operation rollback.
  } catch (error) { if (error instanceof MonoripperError && error.code === 'INVALID_STATE') throw error; invalid() }
}

export class StateStore {
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  healthy = true
  private constructor(private scope: Scope, private snapshot: Snapshot, private release?: () => Promise<void>) {}

  static async open(scope: Scope): Promise<StateStore> {
    let release: (() => Promise<void>) | undefined
    try {
      if (scope.directory) {
        if (process.platform !== 'linux') throw new MonoripperError('PERSISTENCE_UNSUPPORTED', 'Persistent state currently requires Linux native flock')
        await mkdir(scope.directory, { recursive: true, mode: 0o700 })
        const fd = await open(join(scope.directory, 'state.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
        let library: ReturnType<(typeof import('bun:ffi'))['dlopen']> | undefined
        try {
          const { dlopen } = await import('bun:ffi')
          const native = dlopen('libc.so.6', { flock: { args: ['i32', 'i32'], returns: 'i32' } })
          library = native
          // Linux LOCK_EX | LOCK_NB; retain this inode instead of reaping PID lockfiles.
          if (native.symbols.flock(fd.fd, 2 | 4) !== 0) throw new MonoripperError('STATE_LOCKED', 'Another controller owns this state directory')
          release = async () => { await fd.close(); native.close() }
        } catch (error) { await fd.close(); library?.close(); throw error }
      }
      const contexts = scope.contexts ?? Object.keys(scope.initialReleases ?? {})
      const initial: Snapshot = { schemaVersion: 2, project: scope.project, environment: scope.environment, revision: 0,
        desired: Object.fromEntries(contexts.map(name => [name, scope.initial[name] ?? 0])),
        releases: scope.contexts ? {} : { ...scope.initialReleases }, serving: {}, lastGood: {}, autoscale: {}, operations: [] }
      let loaded = initial
      if (scope.directory) {
        let file: FileHandle | undefined
        try {
          file = await open(join(scope.directory, 'state.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
          if (!(await file.stat()).isFile() || (await file.stat()).size > 16 * 1024 * 1024) invalid()
          loaded = migrate(JSON.parse(await file.readFile('utf8'))) as Snapshot
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) invalid()
        } finally { await file?.close() }
      }
      validate(loaded, scope)
      const store = new StateStore(scope, loaded, release)
      await store.persist(loaded)
      return store
    } catch (error) { await release?.(); throw error }
  }

  read(): Snapshot { return structuredClone(this.snapshot) }
  get persistent(): boolean { return !!this.scope.directory }

  update<T>(change: (next: Snapshot) => T): Promise<T> {
    if (this.closed || !this.healthy) return Promise.reject(new MonoripperError('STATE_UNAVAILABLE', 'Controller state is not writable'))
    const work = this.queue.then(async () => {
      if (!this.healthy) throw new MonoripperError('STATE_UNAVAILABLE', 'Controller state is not writable')
      const next = this.read()
      const result = change(next)
      validate(next, this.scope)
      await this.persist(next)
      this.snapshot = next
      return structuredClone(result)
    })
    this.queue = work.catch(() => {})
    return work
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.queue
    await this.release?.()
  }

  private async persist(snapshot: Snapshot) {
    if (!this.scope.directory) return
    const temporary = join(this.scope.directory, `.state-${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(snapshot)); await file.sync() } finally { await file.close() }
      await rename(temporary, join(this.scope.directory, 'state.json'))
      const directory = await open(this.scope.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      this.healthy = false // A failed directory fsync after rename leaves durability uncertain: fail closed until restart.
      throw new MonoripperError('STATE_WRITE_FAILED', 'State persistence failed; restart the controller after repairing storage', { cause: error })
    } finally { await rm(temporary, { force: true }) }
  }
}
