import { strict as assert } from 'node:assert'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const base = 'docker.io/oven/bun:1.3.13-debian@sha256:550178b0d9fefc73c8758eb1ee9bb7eff90747ba1008d80a5bb76695b3fd9265'
export interface Container { name: string; url?: URL }
export interface Status {
  revision: number; healthy: boolean
  workers: { context: string; pid: number; ready: boolean }[]
  contexts: { name: string; desiredReplicas: number; readyReplicas: number }[]
}

export async function until(check: () => Promise<boolean>, timeout = 15_000) {
  const deadline = performance.now() + timeout
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error('Container condition timed out')
    await Bun.sleep(50)
  }
}

export async function withFixture(run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const fixture = await createFixture()
  try { await run(fixture) } finally { await fixture.cleanup() }
}

async function createFixture() {
  assert.equal(process.platform, 'linux', 'Container tests require Linux')
  assert.ok(Bun.which('podman'), 'Rootless Podman required; use nix shell nixpkgs#podman on NixOS')
  const prefix = `monoripper-e01s03-${crypto.randomUUID()}`
  const temp = await mkdtemp(join(tmpdir(), 'monoripper-container-'))
  const token = crypto.randomUUID() + crypto.randomUUID()
  const image = `localhost/monoripper-e01s03:${prefix}`
  const volume = `${prefix}-state`, secret = `${prefix}-token`
  const containers: string[] = []
  let imageBuilt = false, volumeCreated = false, secretCreated = false

  async function command(args: string[], timeout = 30_000, required = true) {
    const child = Bun.spawn(['podman', ...args], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      if (required && code !== 0) throw new Error(`podman ${args[0]} failed (${code}): ${stderr || stdout}`)
      return { stdout: stdout.trim(), stderr: stderr.trim(), code }
    } finally { clearTimeout(timer) }
  }
  async function cleanup() {
    const failures: unknown[] = []
    const attempt = async (args: string[]) => { try { await command(args) } catch (error) { failures.push(error) } }
    if (containers.length) await attempt(['rm', '--force', '--ignore', ...containers])
    if (secretCreated) await attempt(['secret', 'rm', secret])
    if (volumeCreated) await attempt(['volume', 'rm', volume])
    if (imageBuilt) await attempt(['image', 'rm', image])
    await rm(temp, { recursive: true, force: true })
    if (failures.length) throw new AggregateError(failures, 'Test-owned container resource cleanup failed')
  }
  async function exec(container: Container, args: string[], required = true) {
    return command(['exec', container.name, ...args], 30_000, required)
  }
  async function control<T = Status>(container: Container, ...args: string[]): Promise<T> {
    return JSON.parse((await exec(container, ['sh', '/app/example/control.sh', ...args])).stdout) as T
  }
  async function start(options: { ready?: boolean; secret?: boolean; readOnlyState?: boolean; httpPort?: number; startupGate?: boolean } = {}): Promise<Container> {
    const name = `${prefix}-${containers.length}`
    const args = ['run', '--detach', '--pull=never', '--name', name,
      '--userns=keep-id:uid=1000,gid=1000', '--user=1000:1000', '--read-only', '--cap-drop=all',
      '--security-opt=no-new-privileges', '--memory=512m', '--cpus=1', '--pids-limit=128',
      '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m', '--publish=127.0.0.1::3000',
      '--volume', `${volume}:/var/lib/monoripper:${options.readOnlyState ? 'ro' : 'rw'}`]
    if (options.secret !== false) args.push('--secret', `${secret},type=mount,target=monoripper-control,uid=1000,gid=1000,mode=0400`)
    if (options.startupGate) {
      const files = {
        'startup.config.ts': `process.env.MONORIPPER_CONTROL_TOKEN=(await Bun.file('/run/secrets/monoripper-control').text()).trim();
export default ${JSON.stringify({ app: './startup-app.ts', environment: 'container', initial: { user: { replicas: 1 } },
          dataDir: '/var/lib/monoripper/startup-state', http: { host: '0.0.0.0', port: 3000 },
          control: { host: '127.0.0.1', port: 50051, tokenEnv: 'MONORIPPER_CONTROL_TOKEN' },
          lifecycle: { startupTimeoutMs: 20_000, shutdownTimeoutMs: 2000 } })}`,
        'startup-app.ts': `export default ${JSON.stringify({ project: 'container-startup', contexts: {
          user: { entry: './startup-context.ts', owns: [{ method: 'GET', path: '/api/user/status' }], resources: ['file'] },
        }, resources: { file: { entry: './resource.ts', contexts: ['user'] } } })}`,
        'startup-context.ts': `import {defineContext} from 'monoripper'; export default defineContext({
async create({app}) { await Bun.write('/var/lib/monoripper/starting',String(process.pid));
while(!await Bun.file('/var/lib/monoripper/startup-release').exists()) await Bun.sleep(10);
return app.get('/api/user/status',()=>({pid:process.pid})); },
stop() { console.log(JSON.stringify({event:'context-stopped',pid:process.pid})); } })`,
      }
      for (const [name, text] of Object.entries(files)) {
        await writeFile(join(temp, name), text, { mode: 0o600 })
        args.push('--volume', `${join(temp, name)}:/app/example/${name}:ro`)
      }
    }
    args.push(image)
    if (options.startupGate || options.httpPort !== undefined) {
      args.push('serve', '--config', `/app/example/${options.startupGate ? 'startup.config.ts' : 'monoripper.config.ts'}`)
      if (options.httpPort !== undefined) args.push('--port', String(options.httpPort))
    }
    await command(args)
    containers.push(name)
    const container: Container = { name }
    if (options.ready === false) return container
    await until(async () => {
      const state = JSON.parse((await command(['inspect', '--format', '{{json .State}}', name])).stdout) as { Running: boolean }
      const logs = await command(['logs', name])
      if (!state.Running) throw new Error(`Container exited before readiness: ${logs.stdout}\n${logs.stderr}`)
      return logs.stdout.includes('"event":"listening"')
    })
    const address = (await command(['port', name, '3000/tcp'])).stdout
    assert.match(address, /^127\.0\.0\.1:\d+$/)
    container.url = new URL(`http://${address}`)
    return container
  }

  try {
    const info = JSON.parse((await command(['info', '--format=json'])).stdout) as { host: { security: { rootless: boolean } } }
    assert.equal(info.host.security.rootless, true, 'Tests require a rootless engine')
    const policies = [join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'containers/policy.json'),
      join(homedir(), '.config/containers/policy.json'), '/etc/containers/policy.json']
    // Respect configured operator policy. The scoped fallback only initializes an otherwise unconfigured test engine.
    const configured = (await Promise.all(policies.map(async path => {
      try { await lstat(path); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    }))).some(Boolean)
    const policyArgs = configured ? [] : ['--signature-policy', join(import.meta.dir, 'policy.json')]
    await command(['pull', '--policy=missing', ...policyArgs, base], 180_000)
    await command(['build', '--pull=never', ...policyArgs, '--tag', image, '--file', 'Dockerfile', '.'], 180_000)
    imageBuilt = true
    await command(['volume', 'create', volume]); volumeCreated = true
    await writeFile(join(temp, 'token'), token + '\n', { mode: 0o600 })
    await command(['secret', 'create', secret, join(temp, 'token')]); secretCreated = true
    return { start, command, exec, control, cleanup, token, image, volume, containers }
  } catch (error) { await cleanup(); throw error }
}
