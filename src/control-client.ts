import * as grpc from '@grpc/grpc-js'
import { controlService } from './control-protocol'
import { MonoripperError } from './definitions'
import type { AutoscalePolicy, ControlStatus, Operation, SetContextRequest } from './control-types'

export interface ControlClientOptions {
  address: string; token: string; project: string; environment?: string; timeoutMs?: number
  /** Required for non-loopback controllers. `ca` is a PEM bundle for a private CA; `serverName` overrides the verified name. */
  tls?: { ca?: string; serverName?: string }
}
export interface ControlClient {
  getStatus(): Promise<ControlStatus>
  setContext(input: Omit<SetContextRequest, 'project' | 'environment'>): Promise<Operation>
  getOperation(id: string): Promise<Operation>
  waitOperation(id: string, timeoutMs?: number): Promise<Operation>
  /** Enables (policy) or disables (undefined) bounded autoscaling for one context. */
  setAutoscale(context: string, policy?: AutoscalePolicy): Promise<{ context: string; policy?: AutoscalePolicy; revision: number }>
  close(): void
}
/** protobuf defaults turn absent optional fields into '' or null; drop the ones added after the first protocol version. */
function compact<T extends object>(value: T, keys: string[]): T {
  const out = { ...value } as Record<string, unknown>
  for (const key of keys) if (out[key] === '' || out[key] === null || out[key] === undefined) delete out[key]
  return out as T
}
const operationOf = (value: Operation) => compact(value, ['release', 'step', 'warning', 'origin'])
const statusOf = (value: ControlStatus): ControlStatus => ({
  ...value,
  contexts: value.contexts.map(context => compact(context, ['release', 'servingRelease', 'lastGoodRelease', 'autoscale'])),
  workers: value.workers.map(worker => compact(worker, ['release', 'node'])),
  ...(value.nodes?.length ? {} : { nodes: undefined }),
})

export function createControlClient(options: ControlClientOptions): ControlClient {
  if (typeof options.token !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(options.token)) throw new MonoripperError('INVALID_CONFIG', 'Control credential must be a printable ASCII token without whitespace')
  const address = typeof options.address !== 'string' ? null : options.tls
    ? options.address.match(/^([a-zA-Z0-9.-]{1,253}|\[[0-9a-fA-F:.]+\]):([0-9]{1,5})$/)
    : options.address.match(/^(127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/)
  if (!address || Number(address[2]) < 1 || Number(address[2]) > 65535) {
    throw new MonoripperError('INVALID_CONFIG', options.tls ? 'Control address must be host:port' : 'Control client without TLS permits loopback host:port only')
  }
  const timeout = options.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 0x7fffffff) throw new MonoripperError('INVALID_CONFIG', 'Invalid control timeout')
  const credentials = options.tls ? grpc.credentials.createSsl(options.tls.ca ? Buffer.from(options.tls.ca) : null) : grpc.credentials.createInsecure()
  const client = new grpc.Client(`${address[1]}:${Number(address[2])}`, credentials, { 'grpc.max_receive_message_length': 1024 * 1024,
    ...(options.tls?.serverName ? { 'grpc.ssl_target_name_override': options.tls.serverName, 'grpc.default_authority': options.tls.serverName } : {}) })
  const metadata = new grpc.Metadata()
  metadata.set('authorization', `Bearer ${options.token}`)
  const scope = { project: options.project, environment: options.environment ?? 'development' }
  function call<T>(method: string, input: object): Promise<T> {
    const definition = controlService[method]!
    return new Promise((resolve, reject) => client.makeUnaryRequest(definition.path, definition.requestSerialize, definition.responseDeserialize,
      input, metadata, { deadline: Date.now() + timeout }, (error, value) => error ? reject(error) : resolve(value as T)))
  }
  return {
    getStatus: async () => { const status = statusOf(await call<ControlStatus>('GetStatus', scope)); if (!status.nodes) delete status.nodes; return status },
    async setContext(input) {
      if ((input.replicas === undefined && input.release === undefined)
        || (input.replicas !== undefined && (!Number.isSafeInteger(input.replicas) || input.replicas < 0 || input.replicas > 64))
        || (input.release !== undefined && (typeof input.release !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.release)))
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision > 0xffffffff
        || typeof input.requestId !== 'string' || !/^[\w.:-]{1,128}$/.test(input.requestId)
        || typeof input.context !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.context)) {
        throw new MonoripperError('INVALID_ARGUMENT', 'Invalid SetContext request before protobuf encoding')
      }
      return operationOf(await call<Operation>('SetContext', { ...input, ...scope }))
    },
    getOperation: async id => operationOf(await call<Operation>('GetOperation', { ...scope, id })),
    async waitOperation(id, timeoutMs = 30_000) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) throw new MonoripperError('INVALID_ARGUMENT', 'Invalid operation wait timeout')
      const deadline = performance.now() + timeoutMs
      while (true) {
        const operation = operationOf(await call<Operation>('GetOperation', { ...scope, id }))
        if (operation.phase === 'succeeded' || operation.phase === 'failed') return operation
        if (performance.now() >= deadline) throw new MonoripperError('DEADLINE_EXCEEDED', `Operation ${id} is still running; query it again`)
        await Bun.sleep(20)
      }
    },
    async setAutoscale(context, policy) {
      const result = await call<{ context: string; policy: AutoscalePolicy | null; revision: number }>('SetAutoscale', { ...scope, context, ...(policy ? { policy } : {}) })
      return { context: result.context, revision: result.revision, ...(result.policy ? { policy: result.policy } : {}) }
    },
    close: () => client.close(),
  }
}
