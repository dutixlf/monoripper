import { defineContext, requestClientAddress } from '../../../src/index'

let served = 0

export default defineContext({
  create({ app }) {
    return app
      .get('/observed/headers', ({ request }) => {
        served++
        console.log(JSON.stringify({ level: 30, msg: 'served' }))
        console.log('plain line')
        return {
          client: requestClientAddress(request),
          forwardedFor: request.headers.get('x-forwarded-for'),
          realIp: request.headers.get('x-real-ip'),
          proto: request.headers.get('x-forwarded-proto'),
        }
      })
      .get('/observed/crash', () => process.exit(3))
  },
  metrics: () => process.env.METRICS_MODE === 'reserved'
    ? 'monoripper_ready 1\n'
    : `# HELP app_served_total Requests served.\n# TYPE app_served_total counter\napp_served_total{kind="headers"} ${served}\n`,
})
