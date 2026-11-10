import { defineApp } from '../../src/index'

export default defineApp({
  project: 'live-example',
  contexts: {
    // WebSocket upgrades are GET requests: one GET rule covers both .ws() and plain routes under the prefix.
    live: { entry: './live.ts', owns: [{ method: 'GET', path: '/api/live/*' }, { method: 'POST', path: '/api/live/notify' }] },
  },
})
