import { gunzipSync, gzipSync } from 'node:zlib'
import { MonoripperError } from './definitions'

export interface ArchiveFile { path: string; data: Uint8Array; executable?: boolean }
export interface ArchiveLimits { maxArchiveBytes: number; maxExtractedBytes: number; maxEntries: number; maxPathLength: number }
export const defaultArchiveLimits: ArchiveLimits = { maxArchiveBytes: 256 * 1024 * 1024, maxExtractedBytes: 1024 * 1024 * 1024, maxEntries: 10_000, maxPathLength: 255 }

const block = 512
const encoder = new TextEncoder()
const invalid = (message: string): never => { throw new MonoripperError('INVALID_ARCHIVE', message) }

/** Relative POSIX path without empty, `.` or `..` segments, control characters or backslashes. */
export function safeArchivePath(path: string, maxLength = defaultArchiveLimits.maxPathLength): boolean {
  if (typeof path !== 'string' || !path || path.length > maxLength || path.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(path)) return false
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function octal(target: Uint8Array, offset: number, length: number, value: number) {
  target.set(encoder.encode(value.toString(8).padStart(length - 1, '0')), offset)
}
function splitPath(path: string): [string, string] {
  const bytes = encoder.encode(path)
  if (bytes.length <= 100) return ['', path]
  for (let index = path.indexOf('/'); index >= 0; index = path.indexOf('/', index + 1)) {
    const prefix = path.slice(0, index), name = path.slice(index + 1)
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) return [prefix, name]
  }
  return invalid(`Path does not fit a ustar header: ${path}`)
}

/** Deterministic ustar + gzip: sorted regular files, zero mtime/uid/gid, fixed modes, no owner names. */
export function createArchive(files: ArchiveFile[]): Uint8Array<ArrayBuffer> {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const parts: Uint8Array[] = []
  const seen = new Set<string>()
  for (const file of sorted) {
    if (!safeArchivePath(file.path) || seen.has(file.path)) invalid(`Invalid or duplicate archive path: ${file.path}`)
    seen.add(file.path)
    const header = new Uint8Array(block)
    const [prefix, name] = splitPath(file.path)
    header.set(encoder.encode(name), 0)
    octal(header, 100, 8, file.executable ? 0o755 : 0o644)
    octal(header, 108, 8, 0); octal(header, 116, 8, 0)
    octal(header, 124, 12, file.data.length)
    octal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = 0x30
    header.set(encoder.encode('ustar\u000000'), 257)
    header.set(encoder.encode(prefix), 345)
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.set(encoder.encode(sum.toString(8).padStart(6, '0') + '\u0000 '), 148)
    parts.push(header, file.data)
    const padding = (block - (file.data.length % block)) % block
    if (padding) parts.push(new Uint8Array(padding))
  }
  parts.push(new Uint8Array(block * 2))
  const tar = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) { tar.set(part, offset); offset += part.length }
  return new Uint8Array(gzipSync(tar, { level: 9 }))
}

function text(bytes: Uint8Array, offset: number, length: number): string {
  const field = bytes.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return new TextDecoder('utf-8', { fatal: true }).decode(end < 0 ? field : field.subarray(0, end))
}
function readOctal(bytes: Uint8Array, offset: number, length: number): number {
  const value = text(bytes, offset, length).trim()
  if (!/^[0-7]{1,12}$/.test(value)) invalid('Malformed numeric header field')
  const parsed = parseInt(value, 8)
  if (!Number.isSafeInteger(parsed)) invalid('Header value out of range')
  return parsed
}

/**
 * Reads only regular files and directories. Links, devices, FIFOs, pax/GNU extensions, unsafe or duplicate paths,
 * and anything beyond the limits are rejected before any byte reaches the filesystem.
 */
export function readArchive(compressed: Uint8Array, limits: ArchiveLimits = defaultArchiveLimits): Map<string, ArchiveFile> {
  if (compressed.length > limits.maxArchiveBytes) invalid('Archive exceeds the compressed size limit')
  let tar: Uint8Array
  try { tar = new Uint8Array(gunzipSync(compressed, { maxOutputLength: limits.maxExtractedBytes + block * (limits.maxEntries * 2 + 2) })) }
  catch { return invalid('Archive is not valid gzip or exceeds the extracted size limit') }
  const files = new Map<string, ArchiveFile>()
  const directories = new Set<string>()
  let offset = 0, extracted = 0, entries = 0
  while (true) {
    if (offset + block > tar.length) invalid('Archive is truncated')
    const header = tar.subarray(offset, offset + block)
    if (header.every(byte => byte === 0)) break
    if (++entries > limits.maxEntries) invalid('Archive has too many entries')
    if (text(header, 257, 6) !== 'ustar') invalid('Only ustar archives are supported')
    const stored = readOctal(header, 148, 8)
    const copy = header.slice(); copy.fill(0x20, 148, 156)
    if (copy.reduce((total, byte) => total + byte, 0) !== stored) invalid('Header checksum mismatch')
    let path: string
    try { const prefix = text(header, 345, 155), name = text(header, 0, 100); path = prefix ? `${prefix}/${name}` : name }
    catch { return invalid('Header path is not UTF-8') }
    const type = String.fromCharCode(header[156]!)
    const size = readOctal(header, 124, 12)
    const mode = readOctal(header, 100, 8)
    offset += block
    if (type === '5') {
      const directory = path.replace(/\/$/, '')
      if (size !== 0 || !safeArchivePath(directory, limits.maxPathLength) || files.has(directory)) invalid(`Invalid directory entry: ${path}`)
      directories.add(directory)
      continue
    }
    if (type !== '0' && type !== '\u0000') invalid(`Unsupported entry type for ${path}: links, devices and extensions are rejected`)
    if (!safeArchivePath(path, limits.maxPathLength) || files.has(path) || directories.has(path)) invalid(`Unsafe or duplicate path: ${path}`)
    extracted += size
    if (extracted > limits.maxExtractedBytes) invalid('Archive exceeds the extracted size limit')
    if (offset + size > tar.length) invalid('Archive is truncated')
    files.set(path, { path, data: tar.slice(offset, offset + size), executable: (mode & 0o111) !== 0 })
    offset += Math.ceil(size / block) * block
  }
  for (const path of files.keys()) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) if (files.has(parts.slice(0, index).join('/'))) invalid(`File used as directory: ${path}`)
  }
  return files
}

export function sha256Digest(bytes: Uint8Array): string {
  return 'sha256:' + new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}
export const validDigest = (digest: unknown): digest is string => typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(digest)
