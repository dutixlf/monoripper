import { appendFile } from 'node:fs/promises'
import { defineContext } from '../../../src/index'

export default defineContext({
  create({ app, signal }) {
    let timer: ReturnType<typeof setInterval> | undefined
    return app
      .onStart(() => {
        timer = setInterval(() => { void appendFile(process.env.LIFECYCLE_FILE!, 'tick\n') }, 20)
        signal.addEventListener('abort', () => { clearInterval(timer); void appendFile(process.env.LIFECYCLE_FILE!, 'aborted\n') }, { once: true })
      })
      .onStop(async () => { await appendFile(process.env.LIFECYCLE_FILE!, 'stopped\n') })
  },
})
