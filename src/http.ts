const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']

export function forwardingHeaders(source: Headers, request = false): Headers {
  const headers = new Headers(source)
  for (const token of (headers.get('connection') ?? '').split(',')) {
    const name = token.trim()
    // Invalid Connection tokens cannot name a valid header and must not reach Headers.delete().
    if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) headers.delete(name)
  }
  for (const name of hopByHop) headers.delete(name)
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith('x-monoripper-')) headers.delete(name)
  if (request) headers.delete('host')
  return headers
}

export function leasedBody(body: ReadableStream<Uint8Array> | null, release: () => void): ReadableStream<Uint8Array> | null {
  let released = false
  const finish = () => { if (!released) { released = true; release() } }
  if (!body) { finish(); return null }
  const reader = body.getReader()
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) { finish(); controller.close() } else controller.enqueue(next.value)
      } catch (error) { finish(); controller.error(error) }
    },
    async cancel(reason) { try { await reader.cancel(reason) } finally { finish() } },
  })
}

export function publicError(status: number, code: string): Response {
  return Response.json({ error: code }, { status })
}
