import { defineContext } from '../../../src/index'

export default defineContext({
  create: ({ app }) => app.get('/work/slow', async ({ query }) => { await Bun.sleep(Number(query.ms ?? 200)); return { pid: process.pid } }),
})
