import { join } from 'node:path'
import { defineApp, type Runtime } from '../../src/index'
export const root = join(import.meta.dir, '../fixtures/control')
export const app = defineApp({ project: 'control-test', contexts: {
  api: { entry: './api.ts', owns: [{ method: '*', path: '/api/*' }] },
  unused: { entry: './unused.ts', owns: [{ method: '*', path: '/unused/*' }] },
  bad: { entry: './bad.ts', owns: [{ method: '*', path: '/bad/*' }] },
} })
export function change(runtime: Runtime, context: string, replicas: number, requestId = crypto.randomUUID()) {
  return { project: app.project, environment: 'development', context, replicas, requestId, expectedRevision: runtime.getStatus().revision }
}
export async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs
  while (!await predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for runtime condition')
    await Bun.sleep(10)
  }
}
