import { defineConfig } from '../../src/index'

// Gateway + controller. Local capacity 1: further replicas go to node agents.
// The certificates are the repository's test material, for a one-machine demonstration only.
export default defineConfig({
  release: '../../.monoripper/example-release.json',
  registry: { url: 'http://127.0.0.1:4873/', tokenEnv: 'MONORIPPER_REGISTRY_READ_TOKEN' },
  dataDir: '../../.monoripper/example-cluster/controller',
  initial: { user: { replicas: 1 }, billing: { replicas: 1 } },
  capacity: { maxReplicas: 2 },
  http: { host: '127.0.0.1', port: 3000 },
  control: { port: 50051, tokenEnv: 'MONORIPPER_CONTROL_TOKEN' },
  cluster: {
    host: '127.0.0.1', port: 7400, tokenEnv: 'MONORIPPER_CLUSTER_TOKEN', heartbeatTimeoutMs: 3000,
    tls: { certFile: '../../tests/fixtures/tls/server.crt', keyFile: '../../tests/fixtures/tls/server.key' },
    caFile: '../../tests/fixtures/tls/ca.crt',
  },
})
