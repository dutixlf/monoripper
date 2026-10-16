import { defineConfig } from '../../src/index'

export default defineConfig({
  app: './app.ts',
  initial: { user: { replicas: 1 } },
  http: { host: '127.0.0.1', port: 3000, maxRequestBodyBytes: 1024 * 1024 },
  lifecycle: { startupTimeoutMs: 15_000, shutdownTimeoutMs: 10_000, requestTimeoutMs: 30_000 },
})
