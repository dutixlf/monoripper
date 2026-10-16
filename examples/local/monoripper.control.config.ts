import { defineConfig } from '../../src/index'

export default defineConfig({
  app: './app.ts',
  environment: 'development',
  initial: { user: { replicas: 1 } },
  http: { host: '127.0.0.1', port: 3000 },
  dataDir: './.monoripper',
  control: { host: '127.0.0.1', port: 50051, tokenEnv: 'MONORIPPER_CONTROL_TOKEN' },
  recovery: { maxRestarts: 3, backoffMs: 100 },
})
