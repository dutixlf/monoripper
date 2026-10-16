import { strict as assert } from 'node:assert'
import { withFixture } from './fixture'

await withFixture(async fixture => {
  const container = await fixture.start()
  assert.ok(container.url)
  const response = await fetch(new URL('/api/user/status', container.url))
  assert.equal(response.status, 200)
  const body = await response.json() as { context: string; pid: number; uid: number; port: number; adminCredentialPresent: boolean }
  assert.equal(body.context, 'user')
  assert.equal(body.uid, 1000)
  assert.equal(body.adminCredentialPresent, false)
  const status = await fixture.control(container, 'status')
  assert.equal(status.healthy, true)
  assert.equal(status.contexts.find(context => context.name === 'user')?.readyReplicas, 1)
  console.log('PASS: non-root image serves HTTP and authenticated loopback control through exec')

  const image = (await fixture.command(['image', 'inspect', fixture.image])).stdout
  const imageConfig = (JSON.parse(image) as { Config: { User: string } }[])[0]!
  assert.equal(imageConfig.Config.User, '1000:1000')
  const inspect = (await fixture.command(['inspect', container.name])).stdout
  const host = (JSON.parse(inspect) as { HostConfig: {
    Privileged: boolean; ReadonlyRootfs: boolean; PidMode: string; NetworkMode: string
    SecurityOpt: string[]; PortBindings: Record<string, { HostIp: string }[]>
    Binds: string[]
  } }[])[0]!.HostConfig
  assert.equal(host.Privileged, false)
  assert.equal(host.ReadonlyRootfs, true)
  assert.notEqual(host.PidMode, 'host')
  assert.notEqual(host.NetworkMode, 'host')
  assert.ok(host.SecurityOpt.some(value => value.startsWith('no-new-privileges')))
  assert.deepEqual(Object.keys(host.PortBindings), ['3000/tcp'])
  assert.equal(host.PortBindings['3000/tcp']![0]!.HostIp, '127.0.0.1')
  assert.ok(host.Binds.every(value => !value.includes('docker.sock') && !value.includes('podman.sock')))

  await fixture.exec(container, ['bun', '-e', `
    const {strict:a}=require('node:assert'); const {writeFile,stat}=require('node:fs/promises');
    a.equal(process.getuid(),1000); a.equal(process.getgid(),1000); a.equal(Bun.version,'1.3.13');
    const status=await Bun.file('/proc/self/status').text();
    a.match(status,/CapEff:\\s+0+\\n/); a.match(status,/CapBnd:\\s+0+\\n/); a.match(status,/NoNewPrivs:\\s+1/);
    a.equal((await Bun.file('/sys/fs/cgroup/memory.max').text()).trim(),'536870912');
    a.equal((await Bun.file('/sys/fs/cgroup/cpu.max').text()).trim(),'100000 100000');
    a.equal((await Bun.file('/sys/fs/cgroup/pids.max').text()).trim(),'128');
    a.equal((await stat('/run/secrets/monoripper-control')).mode & 0o777,0o400);
    await a.rejects(writeFile('/home/bun/forbidden','x'),{code:'EROFS'});
    a.equal(await Bun.file('/app/src/index.ts').exists(),false);
    a.equal(await Bun.file('/app/.git/HEAD').exists(),false);
    a.equal(await Bun.file('/app/node_modules/embedded-postgres/package.json').exists(),false);
    const rows=(await Bun.file('/proc/net/tcp').text()).trim().split('\\n').slice(1)
      .map(line=>line.trim().split(/\\s+/)).filter(fields=>fields[3]==='0A');
    for(const port of [50051,${body.port}]) {
      const listeners=rows.filter(fields=>parseInt(fields[1].split(':')[1],16)===port);
      a.equal(listeners.length,1); a.equal(listeners[0][1].split(':')[0],'0100007F');
    }
  `])
  console.log('PASS: private listeners, read-only root, dropped capabilities, non-root identity and actual cgroup limits')

  const unauthorized = await fixture.command(['exec', '--env', 'MONORIPPER_CONTROL_TOKEN=not-the-mounted-secret-000000000000',
    container.name, 'bun', '/app/dist/cli.js', 'scale', '--controller', '127.0.0.1:50051', '--project', 'container-example',
    '--environment', 'container', '--context', 'user', '--replicas', '2', '--expected-revision', String(status.revision)], 10_000, false)
  assert.notEqual(unauthorized.code, 0)
  assert.match(unauthorized.stderr, /UNAUTHENTICATED/)
  assert.equal((await fixture.control(container, 'status')).revision, status.revision)
  const snapshot = (await fixture.exec(container, ['bun', '-e', "console.log(await Bun.file('/var/lib/monoripper/state.json').text())"])).stdout
  const logs = await fixture.command(['logs', container.name])
  for (const output of [image, inspect, snapshot, logs.stdout, logs.stderr]) assert.ok(!output.includes(fixture.token), 'Test credential leaked')
  console.log('PASS: unauthorized mutation refused, revision unchanged and secret absent from metadata/state/logs')

  for (const options of [{ ready: false, secret: false }, { ready: false, readOnlyState: true }]) {
    const failed = await fixture.start(options)
    assert.notEqual(Number((await fixture.command(['wait', failed.name], 15_000)).stdout), 0)
    const output = await fixture.command(['logs', failed.name])
    assert.ok(!(output.stdout + output.stderr).includes('"event":"listening"'))
    assert.ok(!(output.stdout + output.stderr).includes(fixture.token))
  }
  console.log('PASS: missing secret and read-only state fail startup without falsely reporting ready')

  await fixture.command(['stop', '--time=5', container.name])
  assert.equal(Number((await fixture.command(['wait', container.name])).stdout), 0)
  const conflict = await fixture.start({ ready: false, httpPort: 50051 })
  assert.notEqual(Number((await fixture.command(['wait', conflict.name], 15_000)).stdout), 0)
  const conflictLogs = (await fixture.command(['logs', conflict.name])).stdout
  assert.ok(conflictLogs.includes('"event":"context-stopped"'))
  assert.ok(conflictLogs.includes('"event":"resource-stopped"'))
  console.log('PASS: control-port collision refuses startup and cleans context/resources')
})
