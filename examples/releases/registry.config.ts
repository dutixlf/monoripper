import { defineRegistry } from '../../src/index'

// Plain HTTP is allowed on loopback only. On a network, add http.tls and use an https URL.
export default defineRegistry({
  dataDir: '../../.monoripper/example-registry',
  http: { host: '127.0.0.1', port: 4873 },
  projects: { example: { readTokenEnv: 'MONORIPPER_REGISTRY_READ_TOKEN', writeTokenEnv: 'MONORIPPER_REGISTRY_TOKEN' } },
})
