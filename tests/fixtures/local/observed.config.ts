import { defineConfig } from '../../../src/index'

export default defineConfig({
  app: './observed.app.ts',
  initial: { observed: { replicas: 1 } },
  http: { host: '127.0.0.1', port: 0 },
  admin: { host: '127.0.0.1', port: 0 },
  logging: { format: 'json' },
})
