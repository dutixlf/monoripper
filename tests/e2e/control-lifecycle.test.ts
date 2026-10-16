import { expect, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectControl, monoripper } from '../../src/index'
import { controlService } from '../../src/control-protocol'
import { app, root } from '../helpers/control'

const tokenName = 'MONORIPPER_TEST_CONTROL_TOKEN'

test('protobuf gRPC authorizes, scales, replays, disables and exposes no admin credential to workers/state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-grpc-'))
  const token = crypto.randomUUID() + crypto.randomUUID()
  const before = process.env[tokenName]
  process.env[tokenName] = token
  const runtime = await monoripper.serve({ app, root, dataDir: directory, initial: { api: { replicas: 1 } }, http: { port: 0 }, control: { tokenEnv: tokenName, port: 0 } })
  const client = await connectControl({ address: runtime.controlAddress!, token, project: app.project })
  const bad = await connectControl({ address: runtime.controlAddress!, token: 'incorrect', project: app.project })
  const wrongScope = await connectControl({ address: runtime.controlAddress!, token, project: 'different-project' })
  try {
    await expect(bad.getStatus()).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED })
    await expect(bad.setContext({ requestId: 'unauthorized-change', expectedRevision: 0, context: 'api', replicas: 0 })).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED })
    await expect(wrongScope.getStatus()).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED })
    await expect(connectControl({ address: runtime.controlAddress!, project: app.project, token: 'PRIVATE_METADATA_VALUE\n' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: 'Control credential must be a printable ASCII token without whitespace' })
    const port80 = await connectControl({ address: '127.0.0.1:80', token, project: app.project })
    port80.close()
    await expect(connectControl({ address: '127.0.0.1:50051?token=PRIVATE_URL_VALUE', token, project: app.project })).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    const start = await client.getStatus()
    expect(start.revision).toBe(0)
    const input = { requestId: 'scale-three', expectedRevision: start.revision, context: 'api', replicas: 3 }
    const operation = await client.setContext(input)
    expect((await client.waitOperation(operation.id)).phase).toBe('succeeded')
    expect((await client.setContext(input)).id).toBe(operation.id)
    const status = await client.getStatus()
    expect(status.contexts.find(context => context.name === 'api')?.readyReplicas).toBe(3)
    await expect(client.setContext({ ...input, requestId: 'conflict' })).rejects.toMatchObject({ code: grpc.status.ABORTED })
    await expect(client.setContext({ ...input, replicas: 1 })).rejects.toMatchObject({ code: grpc.status.ALREADY_EXISTS })
    const disabled = await client.setContext({ requestId: 'disable', expectedRevision: status.revision, context: 'api', replicas: 0 })
    expect((await client.waitOperation(disabled.id)).phase).toBe('succeeded')
    expect((await fetch(new URL('/api/pid', runtime.url))).status).toBe(503)
    const enabled = await client.setContext({ requestId: 'enable-other', expectedRevision: (await client.getStatus()).revision, context: 'unused', replicas: 1 })
    expect((await client.waitOperation(enabled.id)).phase).toBe('succeeded')
    expect((await fetch(new URL('/unused/pid', runtime.url))).status).toBe(200)
    expect(JSON.stringify(await client.getStatus())).not.toContain(token)
    expect(await readFile(join(directory, 'state.json'), 'utf8')).not.toContain(token)
    const again = await client.setContext({ requestId: 'reenable-api', expectedRevision: (await client.getStatus()).revision, context: 'api', replicas: 1 })
    await client.waitOperation(again.id)
    expect((await fetch(new URL('/api/pid', runtime.url)).then(r => r.json())).adminCredential).toBe('')
    await expect(client.setContext({ requestId: 'fractional', expectedRevision: (await client.getStatus()).revision, context: 'api', replicas: 1.5 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(client.waitOperation(again.id, NaN)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    const wire = new grpc.Client(runtime.controlAddress!, grpc.credentials.createInsecure())
    const metadata = new grpc.Metadata(); metadata.set('authorization', `Bearer ${token}`)
    try {
      const method = controlService.SetContext!
      const malformed = new Promise((resolve, reject) => wire.makeUnaryRequest(method.path, method.requestSerialize, method.responseDeserialize,
        { project: app.project, environment: 'development', requestId: 'missing-revision', context: 'api', replicas: 0 }, metadata,
        (error, value) => error ? reject(error) : resolve(value)))
      await expect(malformed).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT })
    } finally { wire.close() }
  } finally {
    client.close(); bad.close(); wrongScope.close()
    await runtime.stop()
    if (before === undefined) delete process.env[tokenName]; else process.env[tokenName] = before
    await rm(directory, { recursive: true, force: true })
  }
})

test('remote plaintext bind and missing credentials fail before creating controller state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monoripper-control-config-'))
  try {
    await expect(monoripper.serve({ app, root, dataDir: directory, initial: {}, control: JSON.parse('{"host":"0.0.0.0","tokenEnv":"MISSING_CONTROL_TOKEN"}') }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    const tokenEnv = 'MISSING_' + crypto.randomUUID().replaceAll('-', '')
    await expect(monoripper.serve({ app, root, dataDir: directory, initial: {}, control: { tokenEnv } }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    expect(await Bun.file(join(directory, 'state.json')).exists()).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
