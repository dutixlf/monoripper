import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withPostgres } from '../../scripts/lib/postgres'

test('embedded PostgreSQL 18 runs real SQL and is removed after a failed test callback', async () => {
  let directory = ''
  let pid = 0
  await expect(withPostgres(async fixture => {
    directory = fixture.directory
    pid = Number((await readFile(join(directory, 'data/postmaster.pid'), 'utf8')).split('\n')[0])
    const sql = new SQL(fixture.url)
    try {
      const [version] = await sql`select current_setting('server_version_num')::int as version, uuidv7()::text as id`
      expect(version.version).toBeGreaterThanOrEqual(180000)
      expect(version.id).toMatch(/^[0-9a-f-]{36}$/)
      await sql`create table fixture_check (value text not null)`
      await sql`insert into fixture_check values ('real postgres')`
      expect((await sql`select value from fixture_check`)[0].value).toBe('real postgres')
      throw new Error('intentional callback failure')
    } finally { await sql.close() }
  })).rejects.toThrow('intentional callback failure')
  expect(directory).not.toBe('')
  expect(await Bun.file(join(directory, 'data/PG_VERSION')).exists()).toBe(false)
  expect(() => process.kill(pid, 0)).toThrow()
}, 30_000)
