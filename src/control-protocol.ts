import { loadSync } from '@grpc/proto-loader'
import type { ServiceDefinition } from '@grpc/grpc-js'
import { fileURLToPath } from 'node:url'

const definitions = loadSync(fileURLToPath(new URL('./control.proto', import.meta.url)), {
  keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true, arrays: true,
})
// proto-loader service methods are structurally the grpc-js service definition.
export const controlService = definitions['monoripper.v1.Control'] as ServiceDefinition
