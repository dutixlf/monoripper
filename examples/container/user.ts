import type { FileHandle } from 'node:fs/promises'
import { defineContext } from 'monoripper'

export default defineContext({
  async create({ app, resources }) {
    await resources.get<FileHandle>('file').stat()
    return app
      .get('/api/user/status', () => ({ context: 'user', pid: process.pid, port: app.server!.port,
        uid: process.getuid!(), adminCredentialPresent: Boolean(process.env.MONORIPPER_CONTROL_TOKEN) }))
      .get('/api/user/stream', () => new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(new TextEncoder().encode('first'))
        await Bun.sleep(750)
        controller.enqueue(new TextEncoder().encode('last'))
        controller.close()
      } })))
  },
  stop() { console.log(JSON.stringify({ event: 'context-stopped', context: 'user', pid: process.pid })) },
})
