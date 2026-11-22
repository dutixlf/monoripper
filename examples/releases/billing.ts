import { defineContext, requestContext } from '../../src/index'

export default defineContext({
  create: ({ app }) => app.get('/api/billing/status', ({ request }) => ({ context: 'billing', pid: process.pid, caller: requestContext(request).caller ?? null })),
})
