import { appendFile } from 'node:fs/promises'
import { defineContext } from '../../../src/index'

export default defineContext({
  create({ app, resources }) {
    const db = resources.get<{ value: string }>('db')
    return app
      .onStart(async () => { await appendFile(process.env.LIFECYCLE_FILE!, 'app:start\n') })
      .onStop(async () => { await appendFile(process.env.LIFECYCLE_FILE!, 'app:stop\n') })
      .post('/api/login', () => ({ pid: process.pid, value: db.value }))
  },
  async stop() { await appendFile(process.env.LIFECYCLE_FILE!, 'context:stop\n') },
})
