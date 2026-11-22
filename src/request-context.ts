import { MonoripperError, type ServiceFetchInit, type Services } from './definitions'

export interface RequestContext {
  traceId: string
  requestId: string
  /** Local epoch milliseconds after which the gateway gives up on this request. */
  deadline: number
  /** Calling context for `services.fetch` requests; absent for public ingress. */
  caller?: string
  claims: Record<string, string>
}
export const traceRule = /^[0-9a-f]{32}$/
export const claimName = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/
const randomHex = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex')
export const newTraceId = () => randomHex(16)

/** W3C traceparent trace-id when valid and non-zero, otherwise a new random id. */
export function traceFrom(headers: Headers): string {
  const match = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(headers.get('traceparent')?.trim() ?? '')
  return match && !/^0+$/.test(match[1]!) ? match[1]! : newTraceId()
}

/** Parses the claim header; anything malformed yields no claims rather than partial trust. */
export function parseClaims(value: string | null, allowed?: readonly string[]): Record<string, string> {
  if (!value || value.length > 4096) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [name, claim] of Object.entries(parsed)) {
      if (!claimName.test(name) || typeof claim !== 'string' || claim.length > 256 || (allowed && !allowed.includes(name))) continue
      out[name] = claim
    }
    return out
  } catch { return {} }
}

/**
 * The gateway's request envelope. The headers are trusted only inside a worker: the gateway removes
 * them from external requests and workers reject requests without the internal credential.
 */
export function requestContext(request: Request): RequestContext {
  const headers = request.headers
  const remaining = Number(headers.get('x-monoripper-deadline-ms'))
  const caller = headers.get('x-monoripper-caller')
  return {
    traceId: headers.get('x-monoripper-trace-id') ?? newTraceId(),
    requestId: headers.get('x-monoripper-request-id') ?? crypto.randomUUID(),
    deadline: Date.now() + (Number.isSafeInteger(remaining) && remaining > 0 ? remaining : 30_000),
    ...(caller ? { caller } : {}),
    claims: parseClaims(headers.get('x-monoripper-claims')),
  }
}

/** Calls other contexts from inside a replica; the runtime supplies the listener URL and credential through the environment. */
export const services: Services = {
    async fetch(path: string, init: ServiceFetchInit = {}) {
      const url = process.env.MONORIPPER_SERVICES_URL, token = process.env.MONORIPPER_SERVICES_TOKEN
      if (!url || !token) throw new MonoripperError('SERVICES_UNAVAILABLE', 'services.fetch is available inside a running context only')
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new MonoripperError('INVALID_ARGUMENT', 'services.fetch takes a path such as /billing/invoices')
      const { request, claims, ...rest } = init
      const headers = new Headers(rest.headers)
      for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith('x-monoripper-')) headers.delete(name)
      headers.set('x-monoripper-services-token', token)
      let timeout: AbortSignal | undefined
      if (request) {
        const parent = requestContext(request)
        const remaining = Math.max(1, parent.deadline - Date.now())
        headers.set('x-monoripper-trace-id', parent.traceId)
        headers.set('x-monoripper-deadline-ms', String(remaining))
        timeout = AbortSignal.timeout(remaining)
      }
      if (claims) headers.set('x-monoripper-claims', JSON.stringify(claims))
      const signal = rest.signal && timeout ? AbortSignal.any([rest.signal, timeout]) : rest.signal ?? timeout
      return fetch(new URL(path, url), { ...rest, headers, redirect: 'manual', proxy: '', ...(signal ? { signal } : {}) })
    },
}
