import { constants } from 'node:fs'
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MonoripperError } from './definitions'
import { assertKeys } from './config'
import type { StoredOperation } from './control-types'

export interface Snapshot {
  schemaVersion: 1
  project: string
  environment: string
  revision: number
  desired: Record<string, number>
  operations: StoredOperation[]
}
interface Scope { project: string; environment: string; contexts: string[]; initial: Record<string, number>; directory?: string }
const uint = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff
const invalid = (): never => { throw new MonoripperError('INVALID_STATE', 'Invalid or incompatible state snapshot; stop the runtime before repairing it') }

function validate(snapshot: Snapshot, scope: Scope) {
  try {
    assertKeys(snapshot, ['schemaVersion', 'project', 'environment', 'revision', 'desired', 'operations'], 'state')
    if (snapshot.schemaVersion !== 1 || snapshot.project !== scope.project || snapshot.environment !== scope.environment || !uint(snapshot.revision)) invalid()
    assertKeys(snapshot.desired, scope.contexts, 'desired')
    if (scope.contexts.some(name => !Object.hasOwn(snapshot.desired, name))) invalid()
    if (Object.values(snapshot.desired).some(n => !uint(n) || n > 64) || Object.values(snapshot.desired).reduce((a, b) => a + b, 0) > 64) invalid()
    if (!Array.isArray(snapshot.operations) || snapshot.operations.length > 10000) invalid()
    const ids = new Set<string>(), requests = new Set<string>(), active = new Set<string>()
    for (const operation of snapshot.operations) {
      assertKeys(operation, ['id', 'requestId', 'context', 'replicas', 'revision', 'phase', 'createdAt', 'updatedAt', 'error', 'payloadHash', 'previousReplicas'], 'operation')
      if (typeof operation.id !== 'string' || !/^[a-f0-9-]{36}$/.test(operation.id) || ids.has(operation.id)) invalid()
      if (typeof operation.requestId !== 'string' || !/^[\w.:-]{1,128}$/.test(operation.requestId) || requests.has(operation.requestId)) invalid()
      if (!scope.contexts.includes(operation.context) || !uint(operation.replicas) || operation.replicas > 64 || !uint(operation.previousReplicas) || operation.previousReplicas > 64) invalid()
      if (!uint(operation.revision) || operation.revision > snapshot.revision || !['accepted', 'applying', 'succeeded', 'failed'].includes(operation.phase)) invalid()
      if (!Number.isSafeInteger(operation.createdAt) || operation.createdAt < 0 || !Number.isSafeInteger(operation.updatedAt) || operation.updatedAt < operation.createdAt) invalid()
      if (typeof operation.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(operation.payloadHash)) invalid()
      if (operation.phase === 'accepted' || operation.phase === 'applying') {
        if (active.has(operation.context) || snapshot.desired[operation.context] !== operation.replicas) invalid()
        active.add(operation.context)
      }
      if (operation.error) {
        assertKeys(operation.error, ['code', 'message'], 'error')
        if (typeof operation.error.code !== 'string' || operation.error.code.length > 80 || typeof operation.error.message !== 'string' || operation.error.message.length > 512) invalid()
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
      const initial: Snapshot = { schemaVersion: 1, project: scope.project, environment: scope.environment, revision: 0,
        desired: Object.fromEntries(scope.contexts.map(name => [name, scope.initial[name] ?? 0])), operations: [] }
      let loaded = initial
      if (scope.directory) {
        let file: FileHandle | undefined
        try {
          file = await open(join(scope.directory, 'state.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
          if (!(await file.stat()).isFile() || (await file.stat()).size > 16 * 1024 * 1024) invalid()
          loaded = JSON.parse(await file.readFile('utf8'))
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
