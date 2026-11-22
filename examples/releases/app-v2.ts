import { defineApp } from '../../src/index'

// The same contexts; user has a new implementation. Packing this manifest produces a different digest.
export default defineApp({
  project: 'example',
  contexts: {
    user: { entry: './user-v2.ts', owns: [{ method: '*', path: '/api/user/*' }] },
    billing: { entry: './billing.ts', owns: [{ method: '*', path: '/api/billing/*' }] },
  },
})
