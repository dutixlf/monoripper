import { appendFile } from 'node:fs/promises'
import { defineContext } from '../../../src/index'

export default defineContext({
  async create({ app }) {
    if (process.env.WORKER_PID_FILE) await Bun.write(process.env.WORKER_PID_FILE, String(process.pid))
    if (process.env.FAILURE_MODE === 'create') throw new Error('create failed')
    if (process.env.FAILURE_MODE === 'timeout') await new Promise(() => {})
    if (process.env.FAILURE_MODE === 'ownership') return app.get('/outside', () => 'bad')
    if (process.env.FAILURE_MODE === 'start-hook') app.onStart(async () => { throw new Error('async start failed') })
    return app.get('/failure', () => 'ok')
  },
  async stop() {
    await appendFile(process.env.LIFECYCLE_FILE!, 'context:stop\n')
    if (process.env.FAILURE_MODE === 'stop') throw new Error('cleanup failed')
  },
})
