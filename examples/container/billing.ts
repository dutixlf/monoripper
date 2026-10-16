import { defineContext } from 'monoripper'

export default defineContext({
  create: ({ app }) => app.get('/api/billing/status', () => ({ context: 'billing', pid: process.pid })),
  stop() { console.log(JSON.stringify({ event: 'context-stopped', context: 'billing', pid: process.pid })) },
})
