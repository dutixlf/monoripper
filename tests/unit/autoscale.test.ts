import { describe, expect, test } from 'bun:test'
import { Autoscaler, decide, type AutoscaleSettings, type Sample } from '../../src/autoscale'

const settings: AutoscaleSettings = { intervalMs: 1000, upWindowMs: 5000, downWindowMs: 20_000, cooldownMs: 10_000, maxStep: 2 }
const policy = { min: 1, max: 6, targetInFlight: 2 }
/** One sample per interval ending at `now`, with the given loads oldest first. */
const series = (now: number, loads: number[]): Sample[] => loads.map((inFlight, index) => ({ at: now - (loads.length - 1 - index) * 1000, inFlight }))
const base = { policy, current: 1, now: 100_000, lastChange: undefined, free: 10, settings }

describe('autoscale decision', () => {
  test('holds on stale, missing or too-short data and during cooldown', () => {
    expect(decide({ ...base, samples: [] })).toBeUndefined()
    expect(decide({ ...base, samples: series(base.now - 2500, [9, 9, 9, 9, 9, 9]) })).toBeUndefined()
    expect(decide({ ...base, samples: series(base.now, [9, 9, 9]) })).toBeUndefined()
    expect(decide({ ...base, samples: series(base.now, [9, 9, 9, 9, 9]) })).toEqual({ replicas: 3, reason: 'load' })
    expect(decide({ ...base, lastChange: base.now - 9000, samples: series(base.now, [9, 9, 9, 9, 9]) })).toBeUndefined()
  })

  test('scales up by average load within max, step and available capacity', () => {
    expect(decide({ ...base, current: 3, samples: series(base.now, [20, 20, 20, 20, 20]) })).toEqual({ replicas: 5, reason: 'load' })
    expect(decide({ ...base, current: 5, samples: series(base.now, [40, 40, 40, 40, 40]) })).toEqual({ replicas: 6, reason: 'load' })
    expect(decide({ ...base, current: 6, samples: series(base.now, [40, 40, 40, 40, 40]) })).toBeUndefined()
    expect(decide({ ...base, free: 1, samples: series(base.now, [9, 9, 9, 9, 9]) })).toEqual({ replicas: 2, reason: 'load' })
    expect(decide({ ...base, free: 0, samples: series(base.now, [9, 9, 9, 9, 9]) })).toBeUndefined()
    // A short spike does not move the average far enough.
    expect(decide({ ...base, current: 2, samples: series(base.now, [2, 2, 2, 2, 8]) })).toBeUndefined()
  })

  test('scales down only after a full quiet window, using the peak (hysteresis)', () => {
    const quiet = Array(21).fill(0)
    expect(decide({ ...base, current: 5, samples: series(base.now, quiet.slice(0, 10)) })).toBeUndefined()
    expect(decide({ ...base, current: 5, samples: series(base.now, quiet) })).toEqual({ replicas: 3, reason: 'quiet' })
    expect(decide({ ...base, current: 2, samples: series(base.now, quiet) })).toEqual({ replicas: 1, reason: 'quiet' })
    const spiky = [...quiet]; spiky[3] = 8
    expect(decide({ ...base, current: 4, samples: series(base.now, spiky) })).toBeUndefined()
    expect(decide({ ...base, current: 1, samples: series(base.now, quiet) })).toBeUndefined()
  })

  test('brings a count outside a changed policy back within bounds immediately', () => {
    expect(decide({ ...base, current: 9, lastChange: base.now, samples: [] })).toEqual({ replicas: 7, reason: 'max' })
    expect(decide({ ...base, policy: { ...policy, min: 4 }, current: 1, lastChange: base.now, samples: [] })).toEqual({ replicas: 3, reason: 'min' })
  })
})

describe('Autoscaler loop with a fake clock', () => {
  test('is deterministic, skips busy contexts, and survives rejected changes', async () => {
    let now = 0
    let load = 8
    let current = 1
    let busy = false
    let reject = false
    const applied: number[] = []
    const scaler = new Autoscaler(settings, {
      policies: () => ({ api: policy }), current: () => current, inFlight: () => load, free: () => 10, busy: () => busy,
      apply: async (_context, replicas) => { if (reject) throw new Error('conflict'); applied.push(replicas); current = replicas },
    }, () => now)
    const run = async (seconds: number) => { for (let i = 0; i < seconds; i++) { await scaler.tick(); now += 1000 } }
    await run(4)
    expect(applied).toEqual([])
    await run(1)
    expect(applied).toEqual([3])
    await run(9)
    expect(applied).toEqual([3]) // Cooldown.
    busy = true
    await run(2)
    expect(applied).toEqual([3])
    busy = false
    await run(1)
    expect(applied).toEqual([3, 4])
    load = 0
    reject = true
    await run(40)
    expect(current).toBe(4)
    reject = false
    await run(1)
    expect(applied).toEqual([3, 4, 2])
    await run(11)
    expect(applied).toEqual([3, 4, 2, 1])
    await run(60)
    expect(applied).toEqual([3, 4, 2, 1])
  })
})
