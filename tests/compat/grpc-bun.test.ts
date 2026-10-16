import { expect, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'

const encode = (value: unknown) => Buffer.from(JSON.stringify(value))
const decode = (value: Buffer) => JSON.parse(value.toString())
const method: grpc.MethodDefinition<unknown, unknown> = {
  path: '/monoripper.Compat/Echo', requestStream: false, responseStream: false,
  requestSerialize: encode, requestDeserialize: decode,
  responseSerialize: encode, responseDeserialize: decode,
}

test('Bun runs real gRPC server/client, metadata, errors, deadlines and shutdown', async () => {
  const server = new grpc.Server()
  server.addService({ echo: method }, {
    echo(call: grpc.ServerUnaryCall<{ slow?: boolean }, unknown>, callback: grpc.sendUnaryData<unknown>) {
      if (call.metadata.get('authorization')[0] !== 'test-only') {
        callback({ code: grpc.status.PERMISSION_DENIED, message: 'Denied' })
      } else if (call.request.slow) {
        const timer = setTimeout(() => callback(null, { ok: true }), 500)
        call.on('cancelled', () => clearTimeout(timer))
      } else {
        callback(null, { ok: true, value: call.request })
      }
    },
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) reject(error)
      else resolve(port)
    })
  })
  const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure())
  const call = (value: unknown, authorized = true, timeout = 2000) => new Promise((resolve, reject) => {
    const metadata = new grpc.Metadata()
    if (authorized) metadata.set('authorization', 'test-only')
    client.makeUnaryRequest(method.path, encode, decode, value, metadata,
      { deadline: Date.now() + timeout }, (error, value) => error ? reject(error) : resolve(value))
  })
  try {
    expect(await call({ message: 'hello' })).toEqual({ ok: true, value: { message: 'hello' } })
    await expect(call({}, false)).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED })
    await expect(call({ slow: true }, true, 50)).rejects.toMatchObject({ code: grpc.status.DEADLINE_EXCEEDED })
  } finally {
    client.close()
    server.forceShutdown()
  }
})
