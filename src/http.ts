const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']

export function forwardingHeaders(source: Headers, request = false): Headers {
  const headers = new Headers(source)
  for (const name of (headers.get('connection') ?? '').split(',')) if (name.trim()) headers.delete(name.trim())
  for (const name of hopByHop) headers.delete(name)
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith('x-monoripper-')) headers.delete(name)
  if (request) headers.delete('host')
  return headers
}

export function publicError(status: number, code: string): Response {
  return Response.json({ error: code }, { status })
}
