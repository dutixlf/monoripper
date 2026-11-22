import { BlockList, isIP } from 'node:net'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MonoripperError, type AppDefinition, type ReleaseRuntimeConfig, type ReleaseServeOptions, type RuntimeConfig, type RuntimeSettings, type ServeOptions } from './definitions'

type Settings = RuntimeSettings & { release?: unknown; registry?: ReleaseRuntimeConfig['registry'] }
import { validateApp } from './ownership'

export function assertKeys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MonoripperError('INVALID_CONFIG', `${label} must be an object`)
  for (const name of Object.keys(value)) if (!allowed.includes(name)) throw new MonoripperError('INVALID_CONFIG', `Unsupported ${label} option: ${name}`)
}

function positive(value: number | undefined, name: string, allowZero = false): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 0x7fffffff)) {
    throw new MonoripperError('INVALID_CONFIG', `Invalid ${name}`)
  }
}

export function validateRuntimeConfig(config: Settings): void {
  assertKeys(config.initial, Object.keys(config.initial ?? {}), 'initial')
  if (config.environment !== undefined && (typeof config.environment !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.environment))) throw new MonoripperError('INVALID_CONFIG', 'Invalid environment')
  if (config.dataDir !== undefined && (typeof config.dataDir !== 'string' || !config.dataDir)) throw new MonoripperError('INVALID_CONFIG', 'Invalid dataDir')
  if (config.recovery !== undefined) {
    assertKeys(config.recovery, ['maxRestarts', 'backoffMs'], 'recovery')
    positive(config.recovery.maxRestarts, 'recovery.maxRestarts', true)
    positive(config.recovery.backoffMs, 'recovery.backoffMs')
    if ((config.recovery.maxRestarts ?? 0) > 100) throw new MonoripperError('INVALID_CONFIG', 'recovery.maxRestarts exceeds 100')
  }
  if (config.release !== undefined && (typeof config.release !== 'string' || !config.release)) throw new MonoripperError('INVALID_CONFIG', 'release must be a release path or <project>@sha256:<hex>')
  if (config.registry !== undefined) {
    assertKeys(config.registry, ['url', 'tokenEnv', 'caFile'], 'registry')
    if (typeof config.registry.url !== 'string' || typeof config.registry.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.registry.tokenEnv)) throw new MonoripperError('INVALID_CONFIG', 'registry needs url and tokenEnv')
    if (config.registry.caFile !== undefined && (typeof config.registry.caFile !== 'string' || !config.registry.caFile)) throw new MonoripperError('INVALID_CONFIG', 'Invalid registry.caFile')
  }
  if (config.capacity !== undefined) {
    assertKeys(config.capacity, ['maxReplicas'], 'capacity')
    positive(config.capacity.maxReplicas, 'capacity.maxReplicas')
    if ((config.capacity.maxReplicas ?? 0) > 64) throw new MonoripperError('INVALID_CONFIG', 'capacity.maxReplicas exceeds 64')
  }
  if (config.control !== undefined) {
    assertKeys(config.control, ['host', 'port', 'tokenEnv', 'tls'], 'control')
    if (config.control.tls !== undefined) {
      assertKeys(config.control.tls, ['certFile', 'keyFile'], 'control.tls')
      if (typeof config.control.tls.certFile !== 'string' || !config.control.tls.certFile || typeof config.control.tls.keyFile !== 'string' || !config.control.tls.keyFile) throw new MonoripperError('INVALID_CONFIG', 'control.tls needs certFile and keyFile')
    }
    if (config.control.host !== undefined && (typeof config.control.host !== 'string' || !config.control.host)) throw new MonoripperError('INVALID_CONFIG', 'Invalid control.host')
    if (config.control.host !== undefined && !config.control.tls && !['127.0.0.1', '::1'].includes(config.control.host)) throw new MonoripperError('INVALID_CONFIG', 'Control without TLS permits loopback only')
    if (typeof config.control.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.control.tokenEnv)) throw new MonoripperError('INVALID_CONFIG', 'control.tokenEnv must name a credential environment variable')
    positive(config.control.port, 'control.port', true)
    if ((config.control.port ?? 0) > 65535) throw new MonoripperError('INVALID_CONFIG', 'Invalid control.port')
  }
  if (config.http !== undefined) {
    assertKeys(config.http, ['host', 'port', 'maxRequestBodyBytes', 'trustedProxies', 'websocket'], 'http')
    if (config.http.host !== undefined && (typeof config.http.host !== 'string' || !config.http.host)) throw new MonoripperError('INVALID_CONFIG', 'Invalid http.host')
    positive(config.http.port, 'http.port', true)
    if ((config.http.port ?? 0) > 65535) throw new MonoripperError('INVALID_CONFIG', 'http.port exceeds 65535')
    positive(config.http.maxRequestBodyBytes, 'http.maxRequestBodyBytes')
    if (config.http.trustedProxies !== undefined) trustedProxyList(config.http.trustedProxies)
    if (config.http.websocket !== undefined) {
      const websocket = config.http.websocket
      assertKeys(websocket, ['maxMessageBytes', 'maxConnections', 'idleTimeoutSeconds', 'maxBufferedBytes'], 'http.websocket')
      for (const [name, value] of Object.entries(websocket)) positive(value, `http.websocket.${name}`)
      if ((websocket.idleTimeoutSeconds ?? 0) > 960) throw new MonoripperError('INVALID_CONFIG', 'http.websocket.idleTimeoutSeconds exceeds 960')
      if (websocket.maxBufferedBytes !== undefined && websocket.maxBufferedBytes < (websocket.maxMessageBytes ?? 1024 * 1024)) {
        throw new MonoripperError('INVALID_CONFIG', 'http.websocket.maxBufferedBytes must be at least maxMessageBytes')
      }
    }
  }
  if (config.admin !== undefined) {
    assertKeys(config.admin, ['host', 'port'], 'admin')
    if (config.admin.host !== undefined && (typeof config.admin.host !== 'string' || !config.admin.host)) throw new MonoripperError('INVALID_CONFIG', 'Invalid admin.host')
    positive(config.admin.port, 'admin.port', true)
    if ((config.admin.port ?? 0) > 65535) throw new MonoripperError('INVALID_CONFIG', 'admin.port exceeds 65535')
  }
  if (config.logging !== undefined) {
    assertKeys(config.logging, ['format'], 'logging')
    if (config.logging.format !== undefined && !['text', 'json'].includes(config.logging.format)) throw new MonoripperError('INVALID_CONFIG', 'logging.format must be text or json')
  }
  if (config.lifecycle !== undefined) {
    assertKeys(config.lifecycle, ['startupTimeoutMs', 'shutdownTimeoutMs', 'requestTimeoutMs'], 'lifecycle')
    for (const [name, value] of Object.entries(config.lifecycle)) positive(value, `lifecycle.${name}`)
  }
  if (config.env !== undefined) {
    assertKeys(config.env, Object.keys(config.env ?? {}), 'env')
    if (Object.entries(config.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))) {
      throw new MonoripperError('INVALID_CONFIG', 'env must contain valid names and string values without null bytes')
    }
  }
  let replicas = 0
  for (const [name, selected] of Object.entries(config.initial)) {
    assertKeys(selected, ['replicas'], `initial.${name}`)
    if (selected.replicas === undefined) throw new MonoripperError('INVALID_CONFIG', `Missing initial.${name}.replicas`)
    positive(selected.replicas, `initial.${name}.replicas`, true)
    replicas += selected.replicas
  }
  if (replicas > 64) throw new MonoripperError('INVALID_CONFIG', 'Prototype limit: 64 total replicas')
}

/** Parses IP and CIDR entries; IPv4-mapped IPv6 peers are normalized before lookup. */
export function trustedProxyList(entries: unknown): BlockList {
  if (!Array.isArray(entries) || entries.length > 256) throw new MonoripperError('INVALID_CONFIG', 'http.trustedProxies must be a list of at most 256 entries')
  const list = new BlockList()
  for (const entry of entries) {
    const [address, bits, extra] = typeof entry === 'string' ? entry.split('/') : []
    const family = address ? isIP(address) : 0
    const prefix = bits === undefined ? undefined : Number(bits)
    if (!family || extra !== undefined || (prefix !== undefined && (!/^\d{1,3}$/.test(bits!) || prefix > (family === 4 ? 32 : 128)))) {
      throw new MonoripperError('INVALID_CONFIG', `Invalid http.trustedProxies entry: ${String(entry)}`)
    }
    const type = family === 4 ? 'ipv4' : 'ipv6'
    if (prefix === undefined) list.addAddress(address!, type)
    else list.addSubnet(address!, prefix, type)
  }
  return list
}

export async function loadApp(filename: string): Promise<{ app: AppDefinition; root: string }> {
  const path = resolve(filename)
  const module = await import(pathToFileURL(path).href)
  const app = module.default ?? module.app
  validateApp(app)
  return { app: structuredClone(app), root: dirname(path) }
}

/** Trusted TypeScript/JavaScript source-mode config. No automatic file discovery or config-file watch. */
export async function loadConfig(filename: string, overrides: Partial<RuntimeSettings> = {}): Promise<ServeOptions> {
  const options = await loadRuntimeConfig(filename, overrides)
  if (!options.app) throw new MonoripperError('INVALID_CONFIG', 'This is a release-mode config; load it with loadRuntimeConfig')
  return options
}

/** Loads a source-mode (`app`) or release-mode (`release`) config. */
export async function loadRuntimeConfig(filename: string, overrides: Partial<RuntimeSettings> = {}): Promise<ServeOptions | ReleaseServeOptions> {
  const path = resolve(filename)
  const original = (await import(pathToFileURL(path).href)).default as RuntimeConfig | ReleaseRuntimeConfig
  const keys = ['app', 'release', 'registry', 'capacity', 'initial', 'http', 'lifecycle', 'env', 'recovery', 'environment', 'dataDir', 'control', 'admin', 'logging']
  assertKeys(original, keys, 'config')
  validateRuntimeConfig(original)
  assertKeys(overrides, keys, 'override')
  validateRuntimeConfig({ initial: overrides.initial ?? {}, ...overrides })
  const config: Settings & { app?: unknown } = {
    ...original, ...overrides,
    initial: structuredClone(overrides.initial ?? original.initial),
    http: { ...original.http, ...overrides.http },
    lifecycle: { ...original.lifecycle, ...overrides.lifecycle },
    recovery: { ...original.recovery, ...overrides.recovery },
    ...(original.control || overrides.control ? { control: { ...original.control!, ...overrides.control } } : {}),
    ...(original.admin || overrides.admin ? { admin: { ...original.admin, ...overrides.admin } } : {}),
    ...(original.logging || overrides.logging ? { logging: { ...original.logging, ...overrides.logging } } : {}),
    env: { ...original.env, ...overrides.env },
  }
  validateRuntimeConfig(config)
  const base = dirname(path)
  if ((config.app === undefined) === (config.release === undefined)) throw new MonoripperError('INVALID_CONFIG', 'Set exactly one of config.app (source mode) and config.release (release mode)')
  if (config.app !== undefined && (typeof config.app !== 'string' || !config.app)) throw new MonoripperError('INVALID_CONFIG', 'config.app must be a manifest path')
  if (config.app !== undefined && config.registry) throw new MonoripperError('INVALID_CONFIG', 'registry applies to release mode only')
  const reference = config.release as string | undefined
  const files = {
    ...(reference && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}@sha256:/.test(reference) ? { release: resolve(base, reference) } : {}),
    ...(config.registry?.caFile ? { registry: { ...config.registry, caFile: resolve(base, config.registry.caFile) } } : {}),
    ...(config.control?.tls ? { control: { ...config.control, tls: { certFile: resolve(base, config.control.tls.certFile), keyFile: resolve(base, config.control.tls.keyFile) } } } : {}),
    ...(config.dataDir ? { dataDir: resolve(base, config.dataDir) } : {}),
  }
  const { app: manifest, ...rest } = config
  if (manifest === undefined) return { ...rest, ...files, release: files.release ?? reference!, root: base } as ReleaseServeOptions
  const { release: _release, registry: _registry, ...source } = { ...rest, ...files }
  return { ...source, ...await loadApp(resolve(base, manifest as string)) }
}
