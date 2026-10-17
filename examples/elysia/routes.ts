import { Elysia, t } from 'elysia'
import type { SQL } from 'bun'

/** Each replica owns a connection pool; all replicas use the same database. */
export function tagsRouter(sql: SQL) {
  const authorized = (headers: Record<string, string | undefined>) =>
    !!process.env.EXAMPLE_API_TOKEN && headers.authorization === `Bearer ${process.env.EXAMPLE_API_TOKEN}`
  return new Elysia()
    .onBeforeHandle(({ set }) => { set.headers['x-test-replica'] = String(process.pid) })
    .onError(({ error }) => {
      if ('errno' in error && error.errno === '23505') return Response.json({ message: 'Duplicate slug' }, { status: 409 })
    })
    .get('/v1/tags', async ({ query }) => sql`
      select id, slug, name from tags where deleted_at is null order by id
      limit ${query.size} offset ${(query.page - 1) * query.size}
    `, { query: t.Object({
      page: t.Numeric({ minimum: 1, default: 1 }),
      size: t.Numeric({ minimum: 1, maximum: 100, default: 20 }),
    }) })
    .get('/v1/tags/:id', async ({ params, status }) => {
      const [tag] = await sql`select id, slug, name from tags where id = ${params.id} and deleted_at is null`
      return tag ?? status(404, { message: 'Not found' })
    }, { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) })
    .post('/v1/tags', async ({ body, headers, status }) => {
      if (!authorized(headers)) return status(401, { message: 'Unauthorized' })
      const [tag] = await sql`insert into tags (slug, name) values (${body.slug}, ${body.name}) returning id, slug, name`
      return tag
    }, { body: t.Object({ slug: t.String({ minLength: 1 }), name: t.String({ minLength: 1 }) }) })
    .patch('/v1/tags/:id', async ({ params, body, headers, status }) => {
      if (!authorized(headers)) return status(401, { message: 'Unauthorized' })
      const [tag] = await sql`update tags set name = ${body.name} where id = ${params.id} and deleted_at is null returning id, slug, name`
      return tag ?? status(404, { message: 'Not found' })
    }, { params: t.Object({ id: t.Numeric({ minimum: 1 }) }), body: t.Object({ name: t.String({ minLength: 1 }) }) })
    .delete('/v1/tags/:id', async ({ params, headers, status }) => {
      if (!authorized(headers)) return status(401, { message: 'Unauthorized' })
      const [tag] = await sql`update tags set deleted_at = now() where id = ${params.id} and deleted_at is null returning id`
      return tag ?? status(404, { message: 'Not found' })
    }, { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) })
}
