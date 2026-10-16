import { defineApp } from 'monoripper'

export default defineApp({
  project: 'container-example',
  contexts: {
    user: { entry: './user.ts', owns: [{ method: '*', path: '/api/user/*' }], resources: ['file'] },
    billing: { entry: './billing.ts', owns: [{ method: '*', path: '/api/billing/*' }], resources: ['file'] },
  },
  resources: { file: { entry: './resource.ts', contexts: ['user', 'billing'] } },
})
