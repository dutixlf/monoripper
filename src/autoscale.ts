import type { AutoscalePolicy } from './control-types'

export interface AutoscaleSettings { intervalMs: number; upWindowMs: number; downWindowMs: number; cooldownMs: number; maxStep: number }
export const defaultAutoscale: AutoscaleSettings = { intervalMs: 1000, upWindowMs: 10_000, downWindowMs: 60_000, cooldownMs: 30_000, maxStep: 2 }
export interface Sample { at: number; inFlight: number }
export interface Decision { replicas: number; reason: 'min' | 'max' | 'load' | 'quiet' }

/**
 * One autoscaler step for one context. Returns undefined to leave the count unchanged.
 * Scale-up uses the average in-flight load over `upWindowMs`; scale-down needs the peak over the longer
 * `downWindowMs` to fit fewer replicas (hysteresis). Stale or too-short windows, cooldown and missing
 * capacity hold the count; every change moves at most `maxStep` and stays within the policy.
 */
export function decide(input: {
  policy: AutoscalePolicy; current: number; samples: Sample[]; now: number; lastChange: number | undefined
  /** Replicas that could still be added on currently available nodes. */
  free: number
  settings: AutoscaleSettings
}): Decision | undefined {
  const { policy, current, samples, now, settings } = input
  const step = (target: number) => current + Math.max(-settings.maxStep, Math.min(settings.maxStep, target - current))
  if (current < policy.min) {
    const replicas = Math.min(step(policy.min), current + input.free)
    return replicas > current ? { replicas, reason: 'min' } : undefined
  }
  if (current > policy.max) return { replicas: step(policy.max), reason: 'max' }
  if (input.lastChange !== undefined && now - input.lastChange < settings.cooldownMs) return undefined
  const last = samples.at(-1)
  if (!last || now - last.at > settings.intervalMs * 2) return undefined // Sampling stalled: do not act on old data.
  const covers = (window: number) => samples.length > 1 && now - samples[0]!.at >= window - settings.intervalMs
  const within = (window: number) => samples.filter(sample => now - sample.at <= window)
  const need = (load: number) => Math.min(policy.max, Math.max(policy.min, Math.ceil(load / policy.targetInFlight)))
  if (covers(settings.upWindowMs)) {
    const recent = within(settings.upWindowMs)
    const average = recent.reduce((sum, sample) => sum + sample.inFlight, 0) / recent.length
    const wanted = need(average)
    if (wanted > current) {
      const replicas = Math.min(step(wanted), current + input.free)
      return replicas > current ? { replicas, reason: 'load' } : undefined
    }
  }
  if (covers(settings.downWindowMs)) {
    const peak = Math.max(...within(settings.downWindowMs).map(sample => sample.inFlight))
    const wanted = need(peak)
    if (wanted < current) return { replicas: step(wanted), reason: 'quiet' }
  }
  return undefined
}

/** Samples in-flight load per context and applies decisions through the controller's normal operations. */
export class Autoscaler {
  private samples = new Map<string, Sample[]>()
  private changed = new Map<string, number>()
  private timer?: ReturnType<typeof setInterval>
  private running = false
  constructor(private settings: AutoscaleSettings, private hooks: {
    policies(): Record<string, AutoscalePolicy>
    current(context: string): number
    inFlight(context: string): number
    free(context: string): number
    busy(context: string): boolean
    apply(context: string, replicas: number): Promise<void>
  }, private now: () => number = () => performance.now()) {}

  start() { this.timer = setInterval(() => void this.tick(), this.settings.intervalMs) }
  stop() { clearInterval(this.timer) }

  /** One sampling and decision round; exposed for deterministic tests. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const now = this.now()
      const policies = this.hooks.policies()
      for (const context of this.samples.keys()) if (!policies[context]) { this.samples.delete(context); this.changed.delete(context) }
      for (const [context, policy] of Object.entries(policies)) {
        const samples = (this.samples.get(context) ?? []).filter(sample => now - sample.at <= this.settings.downWindowMs)
        samples.push({ at: now, inFlight: this.hooks.inFlight(context) })
        this.samples.set(context, samples)
        if (this.hooks.busy(context)) continue
        const decision = decide({ policy, current: this.hooks.current(context), samples, now, lastChange: this.changed.get(context),
          free: this.hooks.free(context), settings: this.settings })
        if (!decision) continue
        try {
          await this.hooks.apply(context, decision.replicas)
          this.changed.set(context, now)
        } catch { /* conflicts with an operator change or a failed start are retried next round */ }
      }
    } finally { this.running = false }
  }
}
