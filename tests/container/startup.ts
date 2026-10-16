import { strict as assert } from 'node:assert'
import { until, withFixture } from './fixture'

await withFixture(async fixture => {
  const container = await fixture.start({ ready: false, startupGate: true })
  await until(async () => (await fixture.exec(container, ['bun', '-e',
    "console.log(await Bun.file('/var/lib/monoripper/starting').exists())"])).stdout === 'true')
  await fixture.command(['stop', '--time=5', container.name])
  assert.equal(Number((await fixture.command(['wait', container.name])).stdout), 0,
    'SIGTERM during worker startup must cancel startup and clean up, not force-kill PID 1')
  const logs = (await fixture.command(['logs', container.name])).stdout
  assert.ok(logs.includes('"event":"context-stopped"'))
  assert.ok(logs.includes('"event":"resource-stopped"'))
  assert.ok(!logs.includes('"event":"listening"'))
  console.log('PASS: PID-1 SIGTERM during blocked startup cancels workers and closes resources without readiness')
})
