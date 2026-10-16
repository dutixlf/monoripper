import { defineContext } from '../../../src/index'

export default defineContext({
  async create({ app }) {
    if (process.env.STARTUP_PID_FILE) await Bun.write(process.env.STARTUP_PID_FILE, String(process.pid))
    while (process.env.STARTUP_GATE && await Bun.file(process.env.STARTUP_GATE).exists()) await Bun.sleep(10)
    return app
      .get('/api/pid', () => ({ pid: process.pid, adminCredential: process.env.MONORIPPER_TEST_CONTROL_TOKEN ?? null }))
      .get('/api/stream', () => new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(new TextEncoder().encode('first'))
        await Bun.sleep(200)
        controller.enqueue(new TextEncoder().encode('last'))
        controller.close()
      } })))
      .get('/api/hang', () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('first'))
      } })))
  },
})
