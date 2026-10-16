import { appendFile } from 'node:fs/promises'
import { defineResource } from '../../../src/index'

export default defineResource({
  async start({ env }) {
    await appendFile(env.LIFECYCLE_FILE!, 'db:start\n')
    return { value: 'resource ready' }
  },
  async stop() { await appendFile(process.env.LIFECYCLE_FILE!, 'db:stop\n') },
})
