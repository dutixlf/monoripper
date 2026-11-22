import { defineConfig } from '../../src/index'

// Release mode: no source checkout. The bootstrap applies to new state only; later releases come from deploy.
export default defineConfig({
  release: '../../.monoripper/example-release.json',
  registry: { url: 'http://127.0.0.1:4873/', tokenEnv: 'MONORIPPER_REGISTRY_READ_TOKEN' },
  dataDir: '../../.monoripper/example-releases',
  initial: { user: { replicas: 2 }, billing: { replicas: 1 } },
  http: { host: '127.0.0.1', port: 3000 },
  control: { port: 50051, tokenEnv: 'MONORIPPER_CONTROL_TOKEN' },
})
