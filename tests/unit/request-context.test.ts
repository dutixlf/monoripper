import { expect, test } from 'bun:test'
import { services } from '../../src/index'

test('service calls use the runtime listener and do not follow redirects', async () => {
  const url = process.env.MONORIPPER_SERVICES_URL
  const token = process.env.MONORIPPER_SERVICES_TOKEN
  const credential = crypto.randomUUID()
  let received: string | null = null
  let redirected = false
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/target') redirected = true
      received = request.headers.get('x-monoripper-services-token')
      return new Response(null, { status: 307, headers: { location: '/target' } })
    },
  })
  try {
    process.env.MONORIPPER_SERVICES_URL = server.url.href
    process.env.MONORIPPER_SERVICES_TOKEN = credential
    const response = await services.fetch('/start', { headers: { 'x-monoripper-services-token': 'replace me' } })
    expect(response.status).toBe(307)
    expect<string | null>(received).toBe(credential)
    expect(redirected).toBe(false)
    await expect(services.fetch(new URL('/target', server.url).href)).rejects.toThrow('takes a path')
  } finally {
    if (url === undefined) delete process.env.MONORIPPER_SERVICES_URL
    else process.env.MONORIPPER_SERVICES_URL = url
    if (token === undefined) delete process.env.MONORIPPER_SERVICES_TOKEN
    else process.env.MONORIPPER_SERVICES_TOKEN = token
    await server.stop(true)
  }
})
