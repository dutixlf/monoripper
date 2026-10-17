import { t } from 'elysia'
import { defineContext } from '../../src/index'

export default defineContext({
  create: ({ app }) => app
    .onError(({ code }) => {
      if (code === 'VALIDATION') return Response.json({ statusCode: 422, message: 'Validation failed' }, { status: 422 })
    })
    .get('/v1/pagination', ({ query }) => ({
      limit: query.size, offset: (query.page - 1) * query.size, order: query.order, pid: process.pid,
    }), {
      query: t.Object({
        page: t.Numeric({ minimum: 1, default: 1 }),
        size: t.Numeric({ minimum: 1, maximum: 100, default: 20 }),
        order: t.Union([t.Literal('asc'), t.Literal('desc')], { default: 'asc' }),
      }),
    })
    .get('/v1/conflict', () => Response.json({ statusCode: 409, message: 'Conflict' }, { status: 409 })),
})
