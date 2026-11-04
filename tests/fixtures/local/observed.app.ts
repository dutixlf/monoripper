import { defineApp } from '../../../src/index'

export default defineApp({
  project: 'observed',
  contexts: {
    observed: { entry: './observed.ts', owns: [{ method: 'GET', path: '/observed/*' }] },
    background: { entry: './background.ts', owns: [] },
  },
})
