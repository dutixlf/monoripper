import type { RuntimeOptions } from './definitions'
import { MonoripperError } from './definitions'
import { startWorker, type ManagedWorker, type WorkerSource } from './process-worker'

/** Owns processes and request leases; controller owns desired counts and serialization. */
export class WorkerPool {
  private workers: ManagedWorker[] = []
  private starting = 0
  private abort = new AbortController()
  constructor(private options: RuntimeOptions, private onUnexpectedExit: (context: string) => void, readonly maxReplicas = 64) {}
  ready(context: string) { return this.workers.filter(worker => worker.context === context && worker.published && !worker.exited && !worker.draining) }
  targets() { return this.workers.filter(worker => worker.published && !worker.exited && !worker.draining).map(({ context, pid, port, token }) => ({ context, pid, port, token })) }
  inFlight(context: string) { return this.workers.reduce((sum, worker) => sum + (worker.context === context ? worker.inFlight : 0), 0) }
  sockets(context: string) { return this.workers.reduce((sum, worker) => sum + (worker.context === context ? worker.sockets.size : 0), 0) }
  /** Live processes, including draining replicas and unpublished candidates. */
  get processes() { return this.workers.length + this.starting }
  status() {
    return this.workers.filter(worker => worker.published).map(worker => ({ context: worker.context, pid: worker.pid, ready: !worker.exited && !worker.draining,
      draining: worker.draining, ...(worker.release ? { release: worker.release } : {}) }))
  }
  cancelStarts() { this.abort.abort() }

  /** Starts ready but unpublished replicas. On any failure the started ones are stopped and the error is rethrown. */
  async startCandidates(context: string, count: number, source: WorkerSource): Promise<ManagedWorker[]> {
    const candidates: ManagedWorker[] = []
    try {
      while (candidates.length < count) {
        if (this.processes >= this.maxReplicas) throw new MonoripperError('CAPACITY_EXCEEDED', 'No replica capacity left for another process')
        this.starting++
        let worker: ManagedWorker
        try {
          worker = await startWorker(context, source, this.options, exited => {
            this.workers = this.workers.filter(item => item !== exited)
            if (exited.published && !exited.draining) this.onUnexpectedExit(exited.context)
          }, this.abort.signal)
        } finally { this.starting-- }
        candidates.push(worker)
        if (!worker.exited) this.workers.push(worker)
      }
      if (candidates.some(worker => worker.exited)) throw new MonoripperError('CONTEXT_START_FAILED', 'Candidate exited before publication')
      return candidates
    } catch (error) {
      await this.stopCandidates(candidates)
      throw error
    }
  }

  async stopCandidates(candidates: ManagedWorker[]) {
    for (const worker of candidates) worker.draining = true
    await Promise.allSettled(candidates.map(worker => this.drain(worker)))
  }

  /**
   * Publishes candidates and withdraws the context's previous ready replicas in one synchronous step,
   * so no request can observe a mixed or empty serving set. Returns the withdrawn replicas for draining.
   */
  switchTo(context: string, candidates: ManagedWorker[]): ManagedWorker[] {
    const previous = this.ready(context).filter(worker => !candidates.includes(worker))
    for (const worker of previous) worker.draining = true
    for (const worker of candidates) worker.published = true
    return previous
  }

  async drainAll(workers: ManagedWorker[]): Promise<void> {
    const results = await Promise.allSettled(workers.map(worker => this.drain(worker)))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length === 1) throw errors[0]!.reason
    if (errors.length) throw new AggregateError(errors.map(error => error.reason), 'Worker drain/cleanup failed')
  }

  async scale(context: string, count: number, source: WorkerSource): Promise<void> {
    const missing = Math.max(0, count - this.ready(context).length)
    const candidates = missing ? await this.startCandidates(context, missing, source) : []
    for (const worker of candidates) worker.published = true
    // Replicas of another release (after a failed deployment restored its predecessor) are withdrawn first.
    const ready = this.ready(context)
    const ordered = [...ready.filter(worker => worker.release !== source.release), ...ready.filter(worker => worker.release === source.release)]
    const withdrawn = ordered.slice(0, Math.max(0, ready.length - count))
    for (const worker of withdrawn) worker.draining = true // Withdraw synchronously before any await.
    await this.drainAll(withdrawn)
  }

  async stop(): Promise<void> {
    this.cancelStarts()
    const workers = [...this.workers]
    for (const worker of workers) worker.draining = true
    const results = await Promise.allSettled(workers.map(worker => this.drain(worker)))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length) throw new AggregateError(errors.map(error => error.reason), 'One or more contexts failed to stop')
  }

  private async drain(worker: ManagedWorker) {
    worker.draining = true
    for (const socket of worker.sockets) socket.goAway()
    const deadline = performance.now() + (this.options.lifecycle?.shutdownTimeoutMs ?? 10_000)
    const busy = () => (worker.inFlight > 0 || worker.sockets.size > 0) && !worker.exited
    while (busy() && performance.now() < deadline) await Bun.sleep(5)
    try {
      if (busy()) {
        await worker.kill()
        throw new MonoripperError('SHUTDOWN_TIMEOUT', `${worker.context} still had active response bodies or WebSockets at shutdown deadline`)
      }
      await worker.stop(Math.max(1, Math.ceil(deadline - performance.now())))
    } finally { this.workers = this.workers.filter(item => item !== worker) }
  }
}
