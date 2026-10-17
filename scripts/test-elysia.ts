import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { defineApp, monoripper } from '../src/index'

const runtime = await monoripper.serve({
  root: fileURLToPath(new URL('../examples/elysia/', import.meta.url)),
  app: defineApp({ project: 'elysia-integration', contexts: {
    catalog: { entry: './pagination.ts', owns: [{ method: '*', path: '/v1/*' }] },
    auth: { entry: './intentionally-not-loaded.ts', owns: [{ method: '*', path: '/auth/*' }] },
  } }),
  initial: { catalog: { replicas: 2 } }, http: { port: 0 },
})
try {
  const request = (path: string) => fetch(new URL(path, runtime.url))
  const defaults = await request('/v1/pagination').then(response => response.json())
  assert.equal(defaults.limit, 20)
  assert.equal(defaults.offset, 0)
  assert.equal(defaults.order, 'asc')
  assert.notEqual(defaults.pid, process.pid)
  const custom = await request('/v1/pagination?page=3&size=50&order=desc').then(response => response.json())
  assert.equal(custom.offset, 100)
  assert.equal(custom.limit, 50)
  assert.equal(custom.order, 'desc')
  assert.notEqual(defaults.pid, custom.pid)
  const pids = new Set(runtime.status().map(worker => worker.pid))
  assert.ok(pids.has(defaults.pid) && pids.has(custom.pid))
  for (const query of ['size=101', 'page=0', 'size=oops']) {
    const response = await request('/v1/pagination?' + query)
    assert.equal(response.status, 422)
    assert.deepEqual(await response.json(), { statusCode: 422, message: 'Validation failed' })
  }
  const conflict = await request('/v1/conflict')
  assert.equal(conflict.status, 409)
  assert.deepEqual(await conflict.json(), { statusCode: 409, message: 'Conflict' })
  assert.equal((await request('/auth/login')).status, 503)
  console.log('PASS: local Elysia pagination, validation and errors in two isolated replicas; disabled context not imported')
} finally {
  const pids = runtime.status().map(worker => worker.pid)
  await runtime.stop()
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), 'Worker must be gone after stop')
}
