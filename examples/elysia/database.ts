import { SQL } from 'bun'
import { defineResource } from '../../src/index'

export default defineResource({
  async start({ env }) {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required')
    const sql = new SQL(env.DATABASE_URL)
    try { await sql`select 1`; return sql }
    catch (error) { await sql.close(); throw error }
  },
  stop: (sql: SQL) => sql.close(),
})
