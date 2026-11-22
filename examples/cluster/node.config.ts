import { defineNode } from '../../src/index'

// A node agent. On a real second machine, bind the private interface and advertise its address.
export default defineNode({
  id: 'node-b',
  project: 'example',
  controller: { url: 'https://127.0.0.1:7400/', tokenEnv: 'MONORIPPER_CLUSTER_TOKEN', caFile: '../../tests/fixtures/tls/ca.crt' },
  listen: { host: '127.0.0.1', port: 7443, tls: { certFile: '../../tests/fixtures/tls/server.crt', keyFile: '../../tests/fixtures/tls/server.key' } },
  advertise: 'https://127.0.0.1:7443/',
  registry: { url: 'http://127.0.0.1:4873/', tokenEnv: 'MONORIPPER_REGISTRY_READ_TOKEN' },
  dataDir: '../../.monoripper/example-cluster/node-b',
  capacity: { maxReplicas: 4 },
})
