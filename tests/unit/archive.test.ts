import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { createArchive, readArchive, safeArchivePath } from '../../src/archive'

const encoder = new TextEncoder()
/** A raw ustar entry with an arbitrary type flag, for archives the writer refuses to produce. */
function rawEntry(name: string, type: string, data = new Uint8Array(0), linkname = '') {
  const header = new Uint8Array(512)
  const octal = (offset: number, length: number, value: number) => header.set(encoder.encode(value.toString(8).padStart(length - 1, '0')), offset)
  header.set(encoder.encode(name), 0)
  octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, data.length); octal(136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = type.charCodeAt(0)
  header.set(encoder.encode(linkname), 157)
  header.set(encoder.encode('ustar\u000000'), 257)
  header.set(encoder.encode(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\u0000 '), 148)
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
  padded.set(data)
  return [header, padded]
}
const tarball = (...entries: Uint8Array[][]) => {
  const parts = [...entries.flat(), new Uint8Array(1024)]
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0))
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return new Uint8Array(gzipSync(out))
}

describe('release archive', () => {
  test('is deterministic, sorted, and round-trips long paths and binary data', () => {
    const long = `${'d'.repeat(120)}/${'f'.repeat(90)}.js`
    const files = [{ path: 'b.js', data: encoder.encode('b') }, { path: long, data: new Uint8Array([0, 255, 1]) }, { path: 'a/x.js', data: encoder.encode('x') }]
    const first = createArchive(files), second = createArchive([...files].reverse())
    expect(first).toEqual(second)
    const read = readArchive(first)
    expect([...read.keys()]).toEqual(['a/x.js', 'b.js', long])
    expect(read.get(long)!.data).toEqual(new Uint8Array([0, 255, 1]))
  })

  test('rejects links, devices, FIFOs, extensions, traversal, absolute and duplicate paths', () => {
    for (const [name, type, link] of [['link', '2', '/etc/passwd'], ['hard', '1', 'other'], ['dev', '3', ''], ['block', '4', ''], ['fifo', '6', ''], ['pax', 'x', ''], ['gnu', 'L', '']] as const) {
      expect(() => readArchive(tarball(rawEntry(name, type, new Uint8Array(0), link)))).toThrow(/Unsupported entry type/)
    }
    for (const name of ['../escape.js', '/abs.js', 'a/../b.js', 'a//b.js', './a.js', 'back\\slash.js']) {
      expect(() => readArchive(tarball(rawEntry(name, '0', encoder.encode('x'))))).toThrow(/Unsafe|Invalid/)
    }
    expect(() => readArchive(tarball(rawEntry('same.js', '0'), rawEntry('same.js', '0')))).toThrow(/duplicate/)
    expect(() => readArchive(tarball(rawEntry('a', '0', encoder.encode('x')), rawEntry('a/b.js', '0')))).toThrow(/File used as directory/)
    for (const path of ['', '..', 'a/./b', 'x\u0000y']) expect(safeArchivePath(path)).toBe(false)
  })

  test('enforces compressed, extracted and entry limits and detects corruption', () => {
    const archive = createArchive([{ path: 'big.js', data: new Uint8Array(100_000) }, { path: 'small.js', data: new Uint8Array(1) }])
    const limits = { maxArchiveBytes: 1 << 20, maxExtractedBytes: 1 << 20, maxEntries: 10, maxPathLength: 255 }
    expect(() => readArchive(archive, { ...limits, maxArchiveBytes: 10 })).toThrow(/compressed size/)
    expect(() => readArchive(archive, { ...limits, maxExtractedBytes: 50_000 })).toThrow(/extracted size/)
    expect(() => readArchive(archive, { ...limits, maxEntries: 1 })).toThrow(/too many entries/)
    expect(() => readArchive(new Uint8Array([1, 2, 3]))).toThrow(/not valid gzip/)
    const [header] = rawEntry('x.js', '0', encoder.encode('x'))
    header![150] = 0x37
    expect(() => readArchive(tarball([header!, new Uint8Array(512)]))).toThrow(/checksum/)
    expect(() => readArchive(new Uint8Array(gzipSync(new Uint8Array(100))))).toThrow(/truncated/)
  })
})
