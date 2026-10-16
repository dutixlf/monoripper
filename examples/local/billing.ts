import { defineContext } from '../../src/index'

export default defineContext({
  create: ({ app }) => app.get('/api/billing/status', () => ({ context: 'billing', pid: process.pid })),
})
