import { defineContext, requestContext } from '../../src/index'

// v2 also calls billing explicitly through the gateway, inheriting the trace and deadline.
export default defineContext({
  create: ({ app, services }) => app.get('/api/user/status', async ({ request }) => {
    const billing = await services.fetch('/api/billing/status', { request })
    return { context: 'user', version: 'v2', pid: process.pid, traceId: requestContext(request).traceId, billing: await billing.json() }
  }),
})
