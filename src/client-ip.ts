import { isIP, type BlockList } from 'node:net'

const forwarding = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-prefix', 'x-real-ip']
const normalize = (address: string) => /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address
const listed = (list: BlockList, address: string) => {
  const family = isIP(address)
  return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

export function isTrustedPeer(list: BlockList | undefined, peer: string | undefined): boolean {
  return !!list && !!peer && listed(list, normalize(peer))
}

/** Walks X-Forwarded-For from the right and returns the first hop that is not a trusted proxy. */
export function clientAddress(list: BlockList | undefined, peer: string | undefined, headers: Headers): string | undefined {
  if (!peer) return undefined
  let candidate = normalize(peer)
  if (!list || !listed(list, candidate)) return candidate
  const chain = (headers.get('x-forwarded-for') ?? '').split(',').map(hop => hop.trim()).filter(Boolean)
  if (!chain.length) {
    const real = normalize(headers.get('x-real-ip')?.trim() ?? '')
    return isIP(real) ? real : candidate
  }
  for (let index = chain.length - 1; index >= 0; index--) {
    const hop = normalize(chain[index]!.replace(/^\[(.*)\]$/, '$1'))
    if (!isIP(hop)) break
    candidate = hop
    if (!listed(list, hop)) break
  }
  return candidate
}

export function stripForwarding(headers: Headers): void {
  for (const name of forwarding) headers.delete(name)
}

/** Client address as resolved by the gateway; the header cannot be supplied by external clients. */
export function requestClientAddress(request: Request): string | undefined {
  return request.headers.get('x-monoripper-client-ip') ?? undefined
}
