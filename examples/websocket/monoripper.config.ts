import { defineConfig } from '../../src/index'

export default defineConfig({
  app: './app.ts',
  initial: { live: { replicas: 1 } },
  http: { host: '127.0.0.1', port: 3000, websocket: { maxMessageBytes: 64 * 1024, maxConnections: 1000, idleTimeoutSeconds: 120 } },
  lifecycle: { shutdownTimeoutMs: 10_000, requestTimeoutMs: 30_000 },
})
