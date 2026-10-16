import { strict as assert } from 'node:assert'
import type { Operation } from '../../src/index'
import { until, withFixture, type Container } from './fixture'

await withFixture(async fixture => {
  const hostPids = async (container: Container) => {
    const output = (await fixture.command(['top', container.name, 'hpid'])).stdout
    const pids = output.split('\n').slice(1).map(line => Number(line.trim()))
    assert.ok(pids.length > 1 && pids.every(pid => Number.isInteger(pid) && pid > 1 && pid !== process.pid))
    return pids
  }
  const assertGone = async (pids: number[]) => until(async () => pids.every(pid => {
    try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
  }), 5000)
  const first = await fixture.start()
  assert.ok(first.url)
  const before = await fixture.control(first, 'status')
  const growth = await fixture.control<Operation>(first, 'scale', '--context', 'user', '--replicas', '3', '--wait')
  assert.equal(growth.phase, 'succeeded')
  const billing = await fixture.control<Operation>(first, 'scale', '--context', 'billing', '--replicas', '1', '--wait')
  assert.equal(billing.phase, 'succeeded')
  let status = await fixture.control(first, 'status')
  assert.equal(status.contexts.find(context => context.name === 'user')?.readyReplicas, 3)
  assert.equal((await fetch(new URL('/api/billing/status', first.url))).status, 200)
  assert.ok(status.revision > before.revision)
  const pids = new Set<number>()
  for (let i = 0; i < 6; i++) {
    const response = await fetch(new URL('/api/user/status', first.url))
    pids.add((await response.json() as { pid: number }).pid)
  }
  assert.equal(pids.size, 3)
  console.log('PASS: real exec gRPC enables billing, scales user 1-to-3 and balances ready replicas')

  const victim = status.workers.find(worker => worker.context === 'user' && worker.ready)!.pid
  await fixture.exec(first, ['bun', '-e', `process.kill(${victim},'SIGKILL')`])
  await until(async () => {
    status = await fixture.control(first, 'status')
    return status.healthy && status.contexts.find(context => context.name === 'user')?.readyReplicas === 3
      && !status.workers.some(worker => worker.pid === victim)
  })
  console.log('PASS: killed container worker is replaced without changing desired replicas')

  const activeWorkers = status.workers.filter(worker => worker.ready)
  const oldHostPids = await hostPids(first)
  const response = await fetch(new URL('/api/user/stream', first.url))
  assert.equal(response.status, 200)
  const reader = response.body!.getReader()
  const firstChunk = await reader.read()
  assert.equal(new TextDecoder().decode(firstChunk.value), 'first')
  const completion = (async () => {
    let body = ''
    while (true) {
      const next = await reader.read()
      if (next.done) return body
      body += new TextDecoder().decode(next.value)
    }
  })()
  const startedAt = performance.now()
  const [tail] = await Promise.all([completion, fixture.command(['stop', '--time=5', first.name])])
  assert.equal(tail, 'last')
  assert.ok(performance.now() - startedAt < 6000, 'SIGTERM exceeded the container grace period')
  assert.equal(Number((await fixture.command(['wait', first.name])).stdout), 0)
  await assertGone(oldHostPids)
  const events = (await fixture.command(['logs', first.name])).stdout.split('\n')
    .filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { event: string; pid?: number })
  for (const worker of activeWorkers) {
    const contextStop = events.findIndex(event => event.event === 'context-stopped' && event.pid === worker.pid)
    const resourceStop = events.findIndex(event => event.event === 'resource-stopped' && event.pid === worker.pid)
    assert.ok(contextStop >= 0 && resourceStop > contextStop, 'Context/resources did not close in order')
  }
  console.log('PASS: SIGTERM drains the complete response, closes contexts/resources and leaves no host worker PIDs')

  const restored = await fixture.start()
  assert.ok(restored.url)
  status = await fixture.control(restored, 'status')
  assert.equal(status.contexts.find(context => context.name === 'user')?.readyReplicas, 3)
  assert.equal(status.contexts.find(context => context.name === 'billing')?.readyReplicas, 1)
  assert.equal((await fixture.control<Operation>(restored, 'operation', '--id', growth.id)).id, growth.id)
  console.log('PASS: recreation on the same volume restores desired counts and durable operation IDs, not initial defaults')

  const requestId = crypto.randomUUID(), expectedRevision = status.revision
  const disabled = await fixture.control<Operation>(restored, 'scale', '--context', 'user', '--replicas', '0', '--wait',
    '--request-id', requestId, '--expected-revision', String(expectedRevision))
  assert.equal(disabled.phase, 'succeeded')
  assert.equal((await fetch(new URL('/api/user/status', restored.url))).status, 503)
  assert.equal((await fetch(new URL('/not-owned', restored.url))).status, 404)
  const killedPids = await hostPids(restored)
  await fixture.command(['kill', '--signal=KILL', restored.name])
  assert.equal(Number((await fixture.command(['wait', restored.name])).stdout), 137)
  await assertGone(killedPids)

  const recovered = await fixture.start()
  assert.ok(recovered.url)
  const after = await fixture.control(recovered, 'status')
  assert.equal(after.healthy, true)
  assert.equal(after.contexts.find(context => context.name === 'user')?.desiredReplicas, 0)
  assert.equal(after.contexts.find(context => context.name === 'billing')?.readyReplicas, 1)
  assert.equal((await fetch(new URL('/api/user/status', recovered.url))).status, 503)
  const repeated = await fixture.control<Operation>(recovered, 'scale', '--context', 'user', '--replicas', '0', '--wait',
    '--request-id', requestId, '--expected-revision', String(expectedRevision))
  assert.equal(repeated.id, disabled.id)
  assert.equal((await fixture.control(recovered, 'status')).revision, after.revision)
  const finalPids = await hostPids(recovered)
  await fixture.command(['stop', '--time=5', recovered.name])
  assert.equal(Number((await fixture.command(['wait', recovered.name])).stdout), 0)
  await assertGone(finalPids)
  console.log('PASS: hard kill leaves no orphan workers; restart preserves disable state and idempotent retries')
})
