import EmbeddedPostgres from 'embedded-postgres'
import { SQL } from 'bun'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

export interface PostgresFixture { url: string; directory: string; port: number }

async function freeLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Cannot allocate test PostgreSQL port')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

/** Test-only database owner. Never accepts DATABASE_URL or a pre-existing data directory. */
export async function withPostgres<T>(run: (fixture: PostgresFixture) => Promise<T>): Promise<T> {
  if (process.getuid?.() === 0) throw new Error('Run embedded PostgreSQL tests as a non-root user; no OS accounts are created')
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-postgres-'))
  const port = await freeLoopbackPort()
  const password = randomBytes(24).toString('hex')
  const logs: string[] = []
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'data'), port, user: 'postgres', password,
    persistent: true, authMethod: 'scram-sha-256', createPostgresUser: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1', '-k', directory],
    onLog(message) { logs.push(message); if (logs.length > 30) logs.shift() },
    onError(error) { logs.push(String(error)); if (logs.length > 30) logs.shift() },
  })
  let running = false
  try {
    try {
      await postgres.initialise()
      await postgres.start()
      running = true
    } catch (error) {
      throw new Error(`embedded-postgres failed to start. Check native binaries/postinstall and NixOS nix-ld.\n${logs.join('')}`, { cause: error })
    }
    const base = `postgresql://postgres:${password}@127.0.0.1:${port}`
    const admin = new SQL(`${base}/postgres`)
    try { await admin.unsafe('CREATE DATABASE monoripper_test') } finally { await admin.close() }
    return await run({ url: `${base}/monoripper_test`, directory, port })
  } finally {
    // Do not remove live database files if shutdown fails. stop() owns the process lifecycle.
    if (running) await postgres.stop()
    await rm(directory, { recursive: true, force: true })
  }
}
