import { expect, test } from 'bun:test'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')

test('CLI checks imports, serves an explicit local config, and stops its workers on SIGTERM', async () => {
  const checked = Bun.spawn([process.execPath, 'src/cli.ts', 'check', '--app', 'examples/local/app.ts'], {
    cwd: root, stdout: 'pipe', stderr: 'pipe',
  })
  const output = await new Response(checked.stdout).text()
  expect(await checked.exited).toBe(0)
  expect(output).toContain('PASS')

  const child = Bun.spawn([process.execPath, 'src/cli.ts', 'serve', '--config', 'examples/local/monoripper.config.ts', '--port', '0'], {
    cwd: root, stdout: 'pipe', stderr: 'inherit',
  })
  let resolveReady!: (value: { url: string; workers: { pid: number }[] }) => void
  const ready = new Promise<{ url: string; workers: { pid: number }[] }>(resolve => { resolveReady = resolve })
  const reader = (async () => {
    let buffer = ''
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('{')) resolveReady(JSON.parse(line))
      }
    }
  })()
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    const status = await Promise.race([ready, child.exited.then(code => { throw new Error(`CLI exited before ready: ${code}`) })])
    expect((await fetch(new URL('/api/user/status', status.url)).then(r => r.json())).context).toBe('user')
    expect((await fetch(new URL('/api/billing/status', status.url))).status).toBe(503)
    child.kill('SIGTERM')
    expect(await child.exited).toBe(0)
    for (const worker of status.workers) expect(() => process.kill(worker.pid, 0)).toThrow()
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
    await reader
  }
}, 10_000)
