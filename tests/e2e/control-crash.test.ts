import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectControl, type ControlClient } from '../../src/index'
import { app, root, until } from '../helpers/control'

const projectRoot = join(import.meta.dir, '../..')
async function launch(config: string) {
  const child = Bun.spawn([process.execPath, 'src/cli.ts', 'serve', '--config', config, '--port', '0'], { cwd: projectRoot, env: { ...process.env }, stdout: 'pipe', stderr: 'inherit' })
  let resolve!: (value: { url: string; controlAddress: string }) => void
  const ready = new Promise<{ url: string; controlAddress: string }>(r => { resolve = r })
  const reader = (async () => {
    let buffer = ''
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk)
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        if (line.startsWith('{')) { const value = JSON.parse(line); if (value.event === 'listening') resolve(value) }
      }
    }
  })()
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
  try {
    const info = await Promise.race([ready, child.exited.then(code => { throw new Error(`Server exited before ready: ${code}`) })])
    return { child, info, async stop() { if (child.exitCode === null) child.kill('SIGTERM'); await child.exited; await reader } }
  } finally { clearTimeout(timer) }
}

test('SIGKILL releases writer lock; accepted operation replays and keeps its requestId/operationId', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-crash-'))
  const tokenName = 'MONORIPPER_CRASH_CONTROL_TOKEN'
  const old = process.env[tokenName]
  const token = crypto.randomUUID() + crypto.randomUUID()
  process.env[tokenName] = token
  const gate = join(directory, 'startup-gate'), pidFile = join(directory, 'worker-pid')
  const manifest = { ...app, contexts: Object.fromEntries(Object.entries(app.contexts).map(([name, spec]) => [name, { ...spec, entry: join(root, spec.entry) }])) }
  await writeFile(join(directory, 'app.ts'), `export default ${JSON.stringify(manifest)}`)
  const config = join(directory, 'config.ts')
  await writeFile(config, `export default ${JSON.stringify({ app: './app.ts', initial: {}, dataDir: './state', http: { port: 0 },
    control: { port: 0, tokenEnv: tokenName }, env: { STARTUP_GATE: gate, STARTUP_PID_FILE: pidFile },
    lifecycle: { startupTimeoutMs: 5000, shutdownTimeoutMs: 1000 } })}`)
  await writeFile(gate, 'pause')
  let server: Awaited<ReturnType<typeof launch>> | undefined
  let client: ControlClient | undefined
  try {
    server = await launch(config)
    client = await connectControl({ address: server.info.controlAddress, token, project: app.project })
    const input = { context: 'api', replicas: 1, requestId: 'survive-controller-crash', expectedRevision: 0 }
    const accepted = await client.setContext(input)
    await until(() => Bun.file(pidFile).exists())
    const oldWorker = Number(await readFile(pidFile, 'utf8'))
    server.child.kill('SIGKILL'); await server.child.exited; client.close()
    await rm(gate)
    server = await launch(config)
    client = await connectControl({ address: server.info.controlAddress, token, project: app.project })
    expect((await client.setContext(input)).id).toBe(accepted.id)
    expect((await client.waitOperation(accepted.id)).phase).toBe('succeeded')
    expect((await client.getStatus()).contexts.find(context => context.name === 'api')?.readyReplicas).toBe(1)
    await until(() => { try { process.kill(oldWorker, 0); return false } catch { return true } })
    expect((await fetch(new URL('/api/pid', server.info.url)).then(r => r.json())).pid).not.toBe(oldWorker)
    expect(await readFile(join(directory, 'state/state.json'), 'utf8')).not.toMatch(/"pid"|"port"/)
    const cli = Bun.spawn([process.execPath, 'src/cli.ts', 'scale', '--controller', server.info.controlAddress, '--project', app.project,
      '--token-env', tokenName, '--context', 'api', '--replicas', '0', '--wait'], { cwd: projectRoot, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
    const result = JSON.parse(await new Response(cli.stdout).text())
    expect(await cli.exited).toBe(0)
    expect(result.phase).toBe('succeeded')
    expect((await fetch(new URL('/api/pid', server.info.url))).status).toBe(503)
    const failed = await client.setContext({ context: 'bad', replicas: 1, requestId: 'cli-failed-operation', expectedRevision: (await client.getStatus()).revision })
    await client.waitOperation(failed.id)
    const poll = Bun.spawn([process.execPath, 'src/cli.ts', 'operation', '--controller', server.info.controlAddress, '--project', app.project,
      '--token-env', tokenName, '--id', failed.id, '--wait'], { cwd: projectRoot, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
    expect(JSON.parse(await new Response(poll.stdout).text()).phase).toBe('failed')
    expect(await poll.exited).toBe(1)
  } finally {
    client?.close(); await server?.stop()
    if (old === undefined) delete process.env[tokenName]; else process.env[tokenName] = old
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
