import { expect, test } from 'bun:test'
import { clientAddress } from '../../src/client-ip'
import { trustedProxyList } from '../../src/config'
import { pipeLines, workerLine } from '../../src/log'
import { merge } from '../../src/metrics'

test('client address walks X-Forwarded-For from the right past trusted proxies only', () => {
  const list = trustedProxyList(['10.0.0.0/8', 'fd00::/8', '192.0.2.1'])
  const headers = (xff?: string, real?: string) => new Headers({ ...(xff ? { 'x-forwarded-for': xff } : {}), ...(real ? { 'x-real-ip': real } : {}) })
  expect(clientAddress(undefined, '10.0.0.1', headers('203.0.113.1'))).toBe('10.0.0.1')
  expect(clientAddress(list, '198.51.100.1', headers('203.0.113.1'))).toBe('198.51.100.1')
  expect(clientAddress(list, '::ffff:10.0.0.1', headers('203.0.113.1, 10.2.2.2'))).toBe('203.0.113.1')
  expect(clientAddress(list, '10.0.0.1', headers('203.0.113.5, 203.0.113.1, 192.0.2.1'))).toBe('203.0.113.1')
  expect(clientAddress(list, '10.0.0.1', headers('10.9.9.9, 10.8.8.8'))).toBe('10.9.9.9')
  expect(clientAddress(list, '10.0.0.1', headers('not-an-ip, 10.8.8.8'))).toBe('10.8.8.8')
  expect(clientAddress(list, 'fd00::1', headers('2001:db8::1'))).toBe('2001:db8::1')
  expect(clientAddress(list, '10.0.0.1', headers(undefined, '203.0.113.7'))).toBe('203.0.113.7')
  expect(clientAddress(list, '10.0.0.1', headers(undefined, 'junk'))).toBe('10.0.0.1')
  for (const bad of ['10.0.0.0/33', 'fd00::/129', 'example.com', '10.0.0.0/8/1', '10.0.0.0/x', 7]) expect(() => trustedProxyList([bad])).toThrow()
})

test('metric merge injects runtime labels, groups families and rejects reserved names or labels', () => {
  const families = new Map()
  expect(merge(families, '# HELP a_total A.\n# TYPE a_total counter\na_total 1\na_total{k="x,}y"} 2\n# TYPE h histogram\nh_bucket{le="1"} 1\nh_sum 1\nh_count 1\n', { context: 'c', worker: '1' })).toBe(true)
  expect(merge(families, '# TYPE a_total counter\na_total 5\n', { context: 'c', worker: '2' })).toBe(true)
  expect(families.get('a_total').samples).toEqual(['a_total{context="c",worker="1"} 1', 'a_total{context="c",worker="1",k="x,}y"} 2', 'a_total{context="c",worker="2"} 5'])
  expect(families.get('h').samples).toHaveLength(3)
  expect(merge(families, '# TYPE a_total gauge\na_total 1\n', { context: 'c', worker: '3' })).toBe(false)
  expect(merge(families, 'monoripper_ready 1\n', { context: 'c', worker: '3' })).toBe(false)
  expect(merge(families, 'b{context="spoof"} 1\n', { context: 'c', worker: '3' })).toBe(false)
  expect(families.get('a_total').samples).toHaveLength(3)
})

test('worker log framing preserves JSON objects, wraps text and bounds line length', async () => {
  expect(JSON.parse(workerLine('{"level":30,"msg":"m","context":"spoof"}', 'ctx', 7, 'stdout'))).toEqual({ level: 30, msg: 'm', context: 'ctx', worker: 7 })
  expect(JSON.parse(workerLine('[1]', 'ctx', 7, 'stderr'))).toMatchObject({ level: 'error', msg: '[1]', context: 'ctx', worker: 7 })
  const seen: [string, boolean][] = []
  const huge = 'x'.repeat(20_000)
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const part of ['one\r\ntw', 'o\n', huge, '\nthree']) controller.enqueue(encoder.encode(part))
    controller.close()
  } })
  await pipeLines(stream, (line, truncated) => { seen.push([line.length > 100 ? `${line.length}` : line, truncated]) })
  expect(seen).toEqual([['one', false], ['two', false], ['16384', true], ['three', false]])
})
