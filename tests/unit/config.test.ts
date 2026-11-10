import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/index'

test('configurations are local, entries resolve against manifest, overrides do not mutate defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monoripper-config-'))
  try {
    await mkdir(join(root, 'app'))
    await mkdir(join(root, 'nodes'))
    await writeFile(join(root, 'app/app.ts'), `export default {project:'config',contexts:{user:{entry:'./user.ts',owns:[{method:'*',path:'/user/*'}]}}}`)
    await writeFile(join(root, 'nodes/a.ts'), `export default {app:'../app/app.ts',initial:{user:{replicas:1}},http:{host:'127.0.0.1',port:3010},lifecycle:{requestTimeoutMs:300},env:{LOCAL:'a'}}`)
    await writeFile(join(root, 'nodes/b.ts'), `export default {app:'../app/app.ts',initial:{},http:{port:3020},env:{LOCAL:'b'}}`)
    const a = await loadConfig(join(root, 'nodes/a.ts'), { http: { port: 0 } })
    const b = await loadConfig(join(root, 'nodes/b.ts'))
    const originalA = await loadConfig(join(root, 'nodes/a.ts'))
    expect(a.root).toBe(join(root, 'app'))
    expect(a.app.contexts.user!.entry).toBe('./user.ts')
    a.app.contexts.user!.entry = './changed-in-one-instance.ts'
    expect(b.app.contexts.user!.entry).toBe('./user.ts')
    expect(a.http).toEqual({ host: '127.0.0.1', port: 0 })
    expect(a.lifecycle?.requestTimeoutMs).toBe(300)
    expect(b.http?.port).toBe(3020)
    expect(b.env?.LOCAL).toBe('b')
    expect(originalA.http?.port).toBe(3010)
    expect(originalA.env?.LOCAL).toBe('a')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('unknown config options fail explicitly instead of silently doing nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monoripper-invalid-config-'))
  try {
    await writeFile(join(root, 'config.ts'), `export default {app:'./app.ts',initial:{},unsupported:true}`)
    await expect(loadConfig(join(root, 'config.ts'))).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('websocket limits are validated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monoripper-websocket-config-'))
  try {
    await writeFile(join(root, 'app.ts'), `export default {project:'ws',contexts:{live:{entry:'./live.ts',owns:[{method:'GET',path:'/live/*'}]}}}`)
    const config = (websocket: string) => `export default {app:'./app.ts',initial:{},http:{websocket:${websocket}}}`
    await writeFile(join(root, 'valid.ts'), config(`{maxMessageBytes:65536,maxConnections:10,idleTimeoutSeconds:960}`))
    expect((await loadConfig(join(root, 'valid.ts'))).http?.websocket).toEqual({ maxMessageBytes: 65536, maxConnections: 10, idleTimeoutSeconds: 960 })
    const invalid = [`{idleTimeoutSeconds:961}`, `{maxConnections:0}`, `{maxMessageBytes:1.5}`, `{compress:true}`, `true`]
    for (const [index, value] of invalid.entries()) {
      await writeFile(join(root, `invalid-${index}.ts`), config(value)) // Distinct files: Bun caches imported modules.
      await expect(loadConfig(join(root, `invalid-${index}.ts`))).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
