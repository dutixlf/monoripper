import * as grpc from '@grpc/grpc-js'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
  RELEASES_DISABLED: grpc.status.FAILED_PRECONDITION, AUTOSCALE_ACTIVE: grpc.status.FAILED_PRECONDITION,
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
      requestId: input.requestId, context: input.context, expectedRevision: input.expectedRevision,
      ...(input.replicas !== undefined && input.replicas !== null ? { replicas: input.replicas } : {}),
      ...(input.release ? { release: input.release } : {}) })),
    GetStatus: handler(() => controller.status()),
    GetOperation: handler<{ project: string; environment: string; id: string }>(input => controller.operation(input.id)),
    SetAutoscale: handler<{ project: string; environment: string; context: string; policy?: { min: number; max: number; targetInFlight: number } | null }>(input =>
      controller.setAutoscale({ project: input.project, environment: input.environment, context: input.context, ...(input.policy ? { policy: input.policy } : {}) })),
  })
  const host = config.host ?? '127.0.0.1'
  if (!config.tls && !['127.0.0.1', '::1'].includes(host)) throw new MonoripperError('INVALID_CONFIG', 'Control without TLS permits loopback only')
  const bracketed = host.includes(':') ? `[${host}]` : host
  const credentials = config.tls
    ? grpc.ServerCredentials.createSsl(null, [{ cert_chain: readFileSync(config.tls.certFile), private_key: readFileSync(config.tls.keyFile) }])
    : grpc.ServerCredentials.createInsecure()
  try {
    const port = await new Promise<number>((resolve, reject) => server.bindAsync(`${bracketed}:${config.port ?? 50051}`, credentials, (error, port) => error ? reject(error) : resolve(port)))
    return { address: `${bracketed}:${port}`, close: () => server.forceShutdown() }
  } catch (error) { server.forceShutdown(); throw error }
}
