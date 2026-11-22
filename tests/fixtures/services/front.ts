import { defineContext, requestContext, services } from '../../../src/index'

export default defineContext({
  create: ({ app }) => app
    .get('/front/call', async ({ request }) => {
      const response = await services.fetch('/back/echo?from=front', { request, claims: { sub: 'user-1', role: 'admin', 'bad name': 'x' }, headers: { 'x-monoripper-caller': 'forged' } })
      return { front: requestContext(request), back: await response.json(), status: response.status }
    })
    .get('/front/missing', async () => (await services.fetch('/nobody/home')).status)
    .get('/front/forge', async () => (await fetch(new URL('/back/echo', process.env.MONORIPPER_SERVICES_URL), { headers: { 'x-monoripper-services-token': 'guess' } })).status),
})
