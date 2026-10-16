import * as grpc from '@grpc/grpc-js'
import { timingSafeEqual } from 'node:crypto'
import { controlService } from './control-protocol'
import { MonoripperError, type RuntimeConfig } from './definitions'
import type { Controller } from './controller'
import type { SetContextRequest } from './control-types'

const codes: Record<string, grpc.status> = {
  INVALID_ARGUMENT: grpc.status.INVALID_ARGUMENT, INVALID_CONFIG: grpc.status.INVALID_ARGUMENT,
  PERMISSION_DENIED: grpc.status.PERMISSION_DENIED, CONFLICT: grpc.status.ABORTED, BUSY: grpc.status.FAILED_PRECONDITION,
  ALREADY_EXISTS: grpc.status.ALREADY_EXISTS, NOT_FOUND: grpc.status.NOT_FOUND,
  CAPACITY_EXCEEDED: grpc.status.RESOURCE_EXHAUSTED, SHUTTING_DOWN: grpc.status.UNAVAILABLE,
  STATE_UNAVAILABLE: grpc.status.UNAVAILABLE, STATE_WRITE_FAILED: grpc.status.UNAVAILABLE, UNIMPLEMENTED: grpc.status.UNIMPLEMENTED,
}
export async function startControlServer(controller: Controller, config: NonNullable<RuntimeConfig['control']>, token: string) {
  const server = new grpc.Server({ 'grpc.max_receive_message_length': 1024 * 1024 })
  const expected = Buffer.from(`Bearer ${token}`)
  function handler<T extends { project: string; environment: string }>(run: (input: T) => unknown) {
    return (call: grpc.ServerUnaryCall<T, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      const supplied = call.metadata.get('authorization')
      const received = Buffer.from(typeof supplied[0] === 'string' ? supplied[0] : '')
      if (supplied.length !== 1 || received.length !== expected.length || !timingSafeEqual(received, expected)) {
        callback({ code: grpc.status.UNAUTHENTICATED, message: 'Invalid control credential' }); return
      }
      const scope = controller.status()
      if (call.request.project !== scope.project || call.request.environment !== scope.environment) {
        callback({ code: grpc.status.PERMISSION_DENIED, message: 'Wrong project or environment' }); return
      }
      Promise.resolve().then(() => run(call.request)).then(value => callback(null, value), error => {
        callback({ code: error instanceof MonoripperError ? codes[error.code] ?? grpc.status.INTERNAL : grpc.status.INTERNAL,
          message: error instanceof MonoripperError ? error.message : 'Control request failed' })
      })
    }
  }
  server.addService(controlService, {
    SetContext: handler<SetContextRequest>(input => controller.set({ project: input.project, environment: input.environment,
      requestId: input.requestId, context: input.context, expectedRevision: input.expectedRevision, replicas: input.replicas })),
    GetStatus: handler(() => controller.status()),
    GetOperation: handler<{ project: string; environment: string; id: string }>(input => controller.operation(input.id)),
    SetAutoscale: handler(() => { throw new MonoripperError('UNIMPLEMENTED', 'Autoscaling is not implemented') }),
  })
  const host = config.host ?? '127.0.0.1'
  if (!['127.0.0.1', '::1'].includes(host)) throw new MonoripperError('INVALID_CONFIG', 'Control currently permits loopback only')
  const address = `${host === '::1' ? '[::1]' : host}:${config.port ?? 50051}`
  try {
    const port = await new Promise<number>((resolve, reject) => server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)))
    return { address: `${host === '::1' ? '[::1]' : host}:${port}`, close: () => server.forceShutdown() }
  } catch (error) { server.forceShutdown(); throw error }
}
