import { defineConfig } from 'monoripper'

// This is trusted bootstrap code. Engine exec reads the same mounted secret.
process.env.MONORIPPER_CONTROL_TOKEN = (await Bun.file('/run/secrets/monoripper-control').text()).trim()
export default defineConfig({
  app: './app.ts',
  environment: 'container',
  initial: { user: { replicas: 1 } },
  dataDir: '/var/lib/monoripper',
  http: { host: '0.0.0.0', port: 3000 },
  control: { host: '127.0.0.1', port: 50051, tokenEnv: 'MONORIPPER_CONTROL_TOKEN' },
  lifecycle: { startupTimeoutMs: 5000, shutdownTimeoutMs: 2000, requestTimeoutMs: 3000 },
  recovery: { maxRestarts: 3, backoffMs: 100 },
})
