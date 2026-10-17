import { defineApp } from '../../src/index'

export default defineApp({
  project: 'elysia-sliced',
  contexts: {
    tags: { entry: './tags.ts', owns: [{ method: '*', path: '/v1/tags/*' }], resources: ['database'] },
    reports: { entry: './reports.ts', owns: [{ method: '*', path: '/v1/reports/*' }] },
  },
  resources: { database: { entry: './database.ts', contexts: ['tags'] } },
})
