import { defineApp } from '../../src/index'

export default defineApp({
  project: 'example',
  contexts: {
    user: { entry: './user.ts', owns: [{ method: '*', path: '/api/user/*' }] },
    billing: { entry: './billing.ts', owns: [{ method: '*', path: '/api/billing/*' }] },
  },
})
