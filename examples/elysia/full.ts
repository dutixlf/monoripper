import type { SQL } from 'bun'
import { defineContext } from '../../src/index'
import { tagsRouter } from './routes'

export default defineContext({
  create: ({ app, resources }) => {
    const sql = resources.get<SQL>('database')
    return app.use(tagsRouter(sql))
      .get('/', () => 'Hello, World!')
      .get('/health', async () => { await sql`select 1`; return { status: 'healthy' } })
  },
})
