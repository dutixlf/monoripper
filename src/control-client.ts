import * as grpc from '@grpc/grpc-js'
import { controlService } from './control-protocol'
import { MonoripperError } from './definitions'
import type { ControlStatus, Operation, SetContextRequest } from './control-types'

export interface ControlClientOptions { address: string; token: string; project: string; environment?: string; timeoutMs?: number }
export interface ControlClient {
  getStatus(): Promise<ControlStatus>
  setContext(input: Omit<SetContextRequest, 'project' | 'environment'>): Promise<Operation>
  getOperation(id: string): Promise<Operation>
  waitOperation(id: string, timeoutMs?: number): Promise<Operation>
  close(): void
}
export function createControlClient(options: ControlClientOptions): ControlClient {
  if (typeof options.token !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(options.token)) throw new MonoripperError('INVALID_CONFIG', 'Control credential must be a printable ASCII token without whitespace')
  const address = typeof options.address === 'string' ? options.address.match(/^(127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/) : null
  if (!address || Number(address[2]) < 1 || Number(address[2]) > 65535) {
    throw new MonoripperError('INVALID_CONFIG', 'Control client currently permits loopback host:port only')
  }
  const timeout = options.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 0x7fffffff) throw new MonoripperError('INVALID_CONFIG', 'Invalid control timeout')
  const client = new grpc.Client(`${address[1]}:${Number(address[2])}`, grpc.credentials.createInsecure(), { 'grpc.max_receive_message_length': 1024 * 1024 })
  const metadata = new grpc.Metadata()
  metadata.set('authorization', `Bearer ${options.token}`)
  const scope = { project: options.project, environment: options.environment ?? 'development' }
  function call<T>(method: string, input: object): Promise<T> {
    const definition = controlService[method]!
    return new Promise((resolve, reject) => client.makeUnaryRequest(definition.path, definition.requestSerialize, definition.responseDeserialize,
      input, metadata, { deadline: Date.now() + timeout }, (error, value) => error ? reject(error) : resolve(value as T)))
  }
  return {
    getStatus: () => call<ControlStatus>('GetStatus', scope),
    async setContext(input) {
      if (!Number.isSafeInteger(input.replicas) || input.replicas < 0 || input.replicas > 64
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision > 0xffffffff
        || typeof input.requestId !== 'string' || !/^[\w.:-]{1,128}$/.test(input.requestId)
        || typeof input.context !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.context)) {
        throw new MonoripperError('INVALID_ARGUMENT', 'Invalid SetContext request before protobuf encoding')
      }
      return call<Operation>('SetContext', { ...input, ...scope })
    },
    getOperation: id => call<Operation>('GetOperation', { ...scope, id }),
    async waitOperation(id, timeoutMs = 30_000) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) throw new MonoripperError('INVALID_ARGUMENT', 'Invalid operation wait timeout')
      const deadline = performance.now() + timeoutMs
      while (true) {
        const operation = await call<Operation>('GetOperation', { ...scope, id })
        if (operation.phase === 'succeeded' || operation.phase === 'failed') return operation
        if (performance.now() >= deadline) throw new MonoripperError('DEADLINE_EXCEEDED', `Operation ${id} is still running; query it again`)
        await Bun.sleep(20)
      }
    },
    close: () => client.close(),
  }
}
