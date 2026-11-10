import { Elysia, t } from 'elysia'
import { defineContext } from '../../src/index'

const topic = 'servers'

const live = new Elysia()
  .ws('/api/live/updates', {
    open(ws) {
      ws.subscribe(topic)
      ws.send({ type: 'hello', replica: process.pid })
    },
    message(ws, message) {
      if (message === 'ping') ws.send({ type: 'pong' })
    },
  })
  // publish() reaches sockets of this replica only. See README.md for several replicas.
  .post('/api/live/notify', ({ body, server }) => {
    server?.publish(topic, JSON.stringify({ type: 'servers.changed', reason: body.reason }))
    return { published: true }
  }, { body: t.Object({ reason: t.String() }) })

export default defineContext({ create: ({ app }) => app.use(live) })
