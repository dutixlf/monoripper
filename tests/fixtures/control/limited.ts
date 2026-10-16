import { open, unlink, type FileHandle } from 'node:fs/promises'
import { defineContext } from '../../../src/index'

let slot: FileHandle | undefined
export default defineContext({
  async create({ app }) {
    // Emulate a dependency that has capacity for only one live replica.
    slot = await open(process.env.MONORIPPER_TEST_SLOT!, 'wx')
    return app.get('/limited/pid', () => ({ pid: process.pid }))
  },
  async stop() {
    if (slot) { await slot.close(); await unlink(process.env.MONORIPPER_TEST_SLOT!) }
  },
})
