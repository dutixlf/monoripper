import { defineContext, requestContext } from '../../../src/index'

export default defineContext({
  create: ({ app }) => app.get('/back/echo', ({ request }) => ({ ...requestContext(request), query: new URL(request.url).search,
    leaked: [...request.headers.keys()].filter(name => /cluster|services/.test(name)) })),
})
