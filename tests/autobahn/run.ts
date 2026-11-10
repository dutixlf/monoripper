// Autobahn TestSuite conformance for the relay's replica-side client: the fuzzing server plays the replica,
// and a fake client echoes every relayed message back through the relay. Requires rootless Podman.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectWebSocket, type RelayClient, type WebSocketRelay } from '../../src/websocket'

const image = 'docker.io/crossbario/autobahn-testsuite@sha256:519915fb568b04c9383f70a1c405ae3ff44ab9e35835b085239c258b6fac3074'
const agent = 'monoripper'
const accepted = new Set(['OK', 'NON-STRICT', 'INFORMATIONAL'])

async function podman(args: string[], required = true) {
  const child = Bun.spawn(['podman', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (required && code !== 0) throw new Error(`podman ${args[0]} failed (${code}): ${stderr || stdout}`)
  return stdout.trim()
}

/** Plain control connections (case count, report update) use Bun's client. */
function control(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    ws.onmessage = event => { text += String(event.data) }
    ws.onclose = () => resolve(text)
    ws.onerror = () => reject(new Error(`control ${path} failed`))
  })
}

async function runCase(port: number, index: number): Promise<void> {
  const result = await connectWebSocket({
    port, target: `/runCase?case=${index}&agent=${agent}`, headers: new Headers(), signal: AbortSignal.timeout(10_000),
    maxMessageBytes: 64 * 1024 * 1024, maxBufferedBytes: 256 * 1024 * 1024, closeTimeoutMs: 2000, idleTimeoutMs: 600_000,
  })
  if (!('relay' in result)) throw new Error(`case ${index}: handshake refused with ${result.status}`)
  const relay: WebSocketRelay = result.relay
  const done = new Promise<void>(resolve => { relay.onDone = () => resolve() })
  const echo: RelayClient = {
    sendText(data) { queueMicrotask(() => relay.fromClient(data)); return data.length },
    sendBinary(data) { const copy = data.slice(); queueMicrotask(() => relay.fromClient(copy)); return copy.length },
    close() {},
  }
  relay.attach(echo)
  const timeout = Bun.sleep(60_000).then(() => { throw new Error(`case ${index} did not finish`) })
  await Promise.race([done, timeout])
}

assert.ok(Bun.which('podman'), 'Rootless Podman required; use nix shell nixpkgs#podman on NixOS')
const work = await mkdtemp(join(tmpdir(), 'monoripper-autobahn-'))
const name = `monoripper-autobahn-${process.pid}`
let started = false
// Autobahn rejects a Host port that differs from its listening port, so both sides use one free port.
const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
const port = probe.port
probe.stop(true)
try {
  await writeFile(join(work, 'fuzzingserver.json'), JSON.stringify({
    url: `ws://0.0.0.0:${port}`, outdir: '/reports', cases: ['*'],
    'exclude-cases': ['12.*', '13.*'], // permessage-deflate is never negotiated by the relay.
    'exclude-agent-cases': {},
  }))
  await podman(['pull', '--policy=missing', '--signature-policy', join(import.meta.dir, 'policy.json'), image])
  await podman(['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:${port}`, '-v', `${work}:/reports`, '-v', `${work}/fuzzingserver.json:/config/fuzzingserver.json:ro`,
    '--pull=never', image, 'wstest', '-m', 'fuzzingserver', '-s', '/config/fuzzingserver.json'])
  started = true
  let count = 0
  for (let attempt = 0; attempt < 150 && !count; attempt++) { // The fuzzing server needs a few seconds to start.
    try { count = Number(await control(port, '/getCaseCount')) } catch { /* not listening yet */ }
    if (!count) await Bun.sleep(200)
  }
  assert.ok(count > 0, 'fuzzing server did not report its cases')
  for (let index = 1; index <= count; index++) await runCase(port, index)
  await control(port, `/updateReports?agent=${agent}`)
  const report = JSON.parse(await readFile(join(work, 'index.json'), 'utf8'))[agent] as Record<string, { behavior: string; behaviorClose: string }>
  const failed = Object.entries(report).filter(([, result]) => !accepted.has(result.behavior) || !accepted.has(result.behaviorClose))
  const summary = Object.values(report).reduce<Record<string, number>>((tally, result) => { tally[result.behavior] = (tally[result.behavior] ?? 0) + 1; return tally }, {})
  console.log(`Autobahn: ${Object.keys(report).length} cases`, summary)
  for (const [id, result] of failed) console.error(`FAIL ${id}: behavior=${result.behavior} close=${result.behaviorClose}`)
  assert.equal(failed.length, 0, `${failed.length} Autobahn cases failed`)
  console.log('PASS: Autobahn client conformance (compression excluded)')
} finally {
  if (started) await podman(['rm', '-f', name], false)
  await rm(work, { recursive: true, force: true })
}
