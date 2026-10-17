import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectControl, defineApp, monoripper, type Runtime, type ControlClient } from '../src/index'
import app from '../examples/elysia/app'
import { withPostgres } from './lib/postgres'

const root = fileURLToPath(new URL('../examples/elysia/', import.meta.url))

async function request(runtime: Runtime, path: string, status: number, options?: RequestInit) {
  const response = await fetch(new URL(path, runtime.url), options)
  const body = await response.json()
  assert.equal(response.status, status, `${options?.method ?? 'GET'} ${path}: ${JSON.stringify(body)}`)
  return { response, body }
}

async function exerciseTags(runtime: Runtime, sql: SQL, token: string, slug: string) {
  const payload = { slug, name: 'Monoripper integration' }
  const create: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(payload) }
  const before = (await sql`select count(*)::int as count from tags`)[0].count
  await request(runtime, '/v1/tags', 401, { ...create, headers: { 'content-type': 'application/json' } })
  assert.equal((await sql`select count(*)::int as count from tags`)[0].count, before)
  const made = await request(runtime, '/v1/tags', 200, create)
  assert.equal(made.body.slug, slug)
  const read = await request(runtime, `/v1/tags/${made.body.id}`, 200)
  assert.equal(read.body.name, payload.name)
  const writer = Number(made.response.headers.get('x-test-replica'))
  const reader = Number(read.response.headers.get('x-test-replica'))
  const pids = new Set(runtime.status().map(worker => worker.pid))
  assert.ok(pids.has(writer) && pids.has(reader), 'Both responses must identify actual workers')
  assert.notEqual(writer, reader, 'Read must reach a different process than write')
  await request(runtime, '/v1/tags', 409, create)
  await request(runtime, '/v1/tags?size=101', 422)
  await request(runtime, '/v1/tags', 422, { ...create, body: JSON.stringify({ slug, name: '' }) })
  for (const method of ['PATCH', 'DELETE']) {
    await request(runtime, `/v1/tags/${made.body.id}`, 401, {
      method, headers: { 'content-type': 'application/json' },
      ...(method === 'PATCH' ? { body: JSON.stringify({ name: 'Unauthorized' }) } : {}),
    })
  }
  assert.equal((await sql`select name from tags where id = ${made.body.id}`)[0].name, payload.name)
  const changed = await request(runtime, `/v1/tags/${made.body.id}`, 200, {
    ...create, method: 'PATCH', body: JSON.stringify({ name: 'Updated through gateway' }),
  })
  assert.equal(changed.body.name, 'Updated through gateway')
  const listed = await request(runtime, '/v1/tags?page=1&size=10', 200)
  assert.ok(listed.body.some((tag: { id: number }) => tag.id === made.body.id))
  await request(runtime, `/v1/tags/${made.body.id}`, 200, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
  await request(runtime, `/v1/tags/${made.body.id}`, 404)
  const after = await request(runtime, '/v1/tags', 200)
  assert.ok(!after.body.some((tag: { id: number }) => tag.id === made.body.id))
  const [row] = await sql`select deleted_at from tags where id = ${made.body.id}`
  assert.ok(row.deleted_at, 'Soft delete must preserve the real database row')
}

async function stopAndVerify(runtime: Runtime) {
  const pids = runtime.status().map(worker => worker.pid)
  await runtime.stop()
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), 'Worker must be gone after stop')
}

const directory = await mkdtemp(join(tmpdir(), 'monoripper-elysia-'))
try {
  await withPostgres(async postgres => {
    const sql = new SQL(postgres.url)
    try {
      await sql.unsafe(await Bun.file(join(root, 'migration.sql')).text()).simple()
      console.log('Applied local Elysia example migration on PostgreSQL 18')
      const token = randomBytes(24).toString('hex')
      const marker = join(directory, 'disabled-context-imported')
      const env = { DATABASE_URL: postgres.url, EXAMPLE_API_TOKEN: token, DISABLED_CONTEXT_MARKER: marker }
      const full = await monoripper.serve({
        root,
        app: defineApp({ project: 'elysia-full', contexts: {
          backend: { entry: './full.ts', owns: [{ method: '*', path: '/*' }], resources: ['database'] },
        }, resources: { database: { entry: './database.ts', contexts: ['backend'] } } }),
        initial: { backend: { replicas: 2 } }, http: { port: 0 }, env,
      })
      try {
        assert.equal(full.status().length, 2)
        assert.notEqual(full.status()[0]!.pid, full.status()[1]!.pid)
        assert.equal(await fetch(new URL('/', full.url)).then(response => response.text()), 'Hello, World!')
        assert.equal((await request(full, '/health', 200)).body.status, 'healthy')
        await exerciseTags(full, sql, token, 'full-backend-tag')
        console.log('PASS: full Elysia app in two replicas: health, authenticated CRUD, cross-replica DB reads and soft delete')
      } finally { await stopAndVerify(full) }

      const controlEnv = 'MONORIPPER_ELYSIA_CONTROL_TOKEN'
      const previousCredential = process.env[controlEnv]
      const credential = randomBytes(32).toString('hex')
      process.env[controlEnv] = credential
      const options = {
        root, app, initial: { tags: { replicas: 1 } }, http: { port: 0 }, env,
        dataDir: join(directory, 'controller-state'), control: { tokenEnv: controlEnv, port: 0 },
      }
      let sliced: Runtime | undefined
      let client: ControlClient | undefined
      try {
        sliced = await monoripper.serve(options)
        client = await connectControl({ address: sliced.controlAddress!, token: credential, project: app.project })
        const scaled = await client.setContext({ context: 'tags', replicas: 3, requestId: 'elysia-scale-three', expectedRevision: (await client.getStatus()).revision })
        assert.equal((await client.waitOperation(scaled.id)).phase, 'succeeded')
        assert.equal((await client.getStatus()).contexts.find(context => context.name === 'tags')?.readyReplicas, 3)
        await exerciseTags(sliced, sql, token, 'sliced-context-tag')
        const killed = sliced.status().find(worker => worker.context === 'tags')!.pid
        process.kill(killed, 'SIGKILL')
        const deadline = performance.now() + 10_000
        while (sliced.status().length !== 3 || sliced.status().some(worker => worker.pid === killed)) {
          if (performance.now() > deadline) throw new Error('Elysia worker did not recover')
          await Bun.sleep(20)
        }
        client.close(); await stopAndVerify(sliced)
        sliced = await monoripper.serve({ ...options, initial: {} })
        client = await connectControl({ address: sliced.controlAddress!, token: credential, project: app.project })
        assert.equal((await client.getStatus()).contexts.find(context => context.name === 'tags')?.readyReplicas, 3)
        assert.equal((await request(sliced, '/v1/tags', 200)).body.length, 0)
        await request(sliced, '/v1/reports', 503)
        assert.equal(await Bun.file(marker).exists(), false, 'Disabled context bootstrap must not be imported')
        const disabled = await client.setContext({ context: 'tags', replicas: 0, requestId: 'elysia-disable', expectedRevision: (await client.getStatus()).revision })
        assert.equal((await client.waitOperation(disabled.id)).phase, 'succeeded')
        await request(sliced, '/v1/tags', 503)
        console.log('PASS: Elysia tags gRPC 1→3 replicas, worker SIGKILL recovery, controller restart restores 3, disable→503; shared PostgreSQL data preserved')
      } finally {
        try { client?.close(); if (sliced) await stopAndVerify(sliced) }
        finally { if (previousCredential === undefined) delete process.env[controlEnv]; else process.env[controlEnv] = previousCredential }
      }
      const [stored] = await sql`select count(*)::int as total, count(*) filter (where deleted_at is not null)::int as deleted from tags`
      assert.equal(stored.total, 2)
      assert.equal(stored.deleted, 2)
    } finally { await sql.close() }
  })
} finally { await rm(directory, { recursive: true, force: true }) }
console.log('PASS: embedded PostgreSQL and temporary state cleaned; no external checkouts or production services used')
