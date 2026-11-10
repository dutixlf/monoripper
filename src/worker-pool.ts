import type { AppDefinition, ServeOptions } from './definitions'
import { MonoripperError } from './definitions'
import { startWorker, type ManagedWorker } from './process-worker'

/** Owns processes and request leases; controller owns desired counts and serialization. */
export class WorkerPool {
  private workers: ManagedWorker[] = []
  private abort = new AbortController()
  constructor(private app: AppDefinition, private options: ServeOptions, private onUnexpectedExit: (context: string) => void) {}
  ready(context: string) { return this.workers.filter(worker => worker.context === context && !worker.exited && !worker.draining) }
  targets() { return this.workers.filter(worker => !worker.exited && !worker.draining).map(({ context, pid, port, token }) => ({ context, pid, port, token })) }
  inFlight(context: string) { return this.workers.reduce((sum, worker) => sum + (worker.context === context ? worker.inFlight : 0), 0) }
  sockets(context: string) { return this.workers.reduce((sum, worker) => sum + (worker.context === context ? worker.sockets.size : 0), 0) }
  status() { return this.workers.map(worker => ({ context: worker.context, pid: worker.pid, ready: !worker.exited && !worker.draining, draining: worker.draining })) }
  cancelStarts() { this.abort.abort() }

  async scale(context: string, count: number): Promise<void> {
    const candidates: ManagedWorker[] = []
    try {
      while (this.ready(context).length + candidates.length < count) {
        candidates.push(await startWorker(context, this.app, this.options, worker => {
          this.workers = this.workers.filter(item => item !== worker)
          if (worker.published && !worker.draining) this.onUnexpectedExit(worker.context)
        }, this.abort.signal))
      }
      if (candidates.some(worker => worker.exited)) throw new MonoripperError('CONTEXT_START_FAILED', 'Candidate exited before publication')
      for (const worker of candidates) worker.published = true
      this.workers.push(...candidates)
    } catch (error) {
      await Promise.allSettled(candidates.map(worker => this.drain(worker)))
      throw error
    }
    const withdrawn = this.ready(context).slice(count)
    for (const worker of withdrawn) worker.draining = true // Withdraw synchronously before any await.
    const results = await Promise.allSettled(withdrawn.map(worker => this.drain(worker)))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length === 1) throw errors[0]!.reason
    if (errors.length) throw new AggregateError(errors.map(error => error.reason), 'Worker drain/cleanup failed')
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
    if (busy()) {
      await worker.kill()
      throw new MonoripperError('SHUTDOWN_TIMEOUT', `${worker.context} still had active response bodies or WebSockets at shutdown deadline`)
    }
    await worker.stop(Math.max(1, Math.ceil(deadline - performance.now())))
    this.workers = this.workers.filter(item => item !== worker)
  }
}
