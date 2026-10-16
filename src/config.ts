import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MonoripperError, type RuntimeConfig, type ServeOptions } from './definitions'
import { validateApp } from './ownership'

export function assertKeys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MonoripperError('INVALID_CONFIG', `${label} must be an object`)
  for (const name of Object.keys(value)) if (!allowed.includes(name)) throw new MonoripperError('INVALID_CONFIG', `Unsupported ${label} option: ${name}`)
}

function positive(value: number | undefined, name: string, allowZero = false): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))) {
    throw new MonoripperError('INVALID_CONFIG', `Invalid ${name}`)
  }
}

export function validateRuntimeConfig(config: Omit<RuntimeConfig, 'app'>): void {
  assertKeys(config.initial, Object.keys(config.initial ?? {}), 'initial')
  if (config.http !== undefined) {
    assertKeys(config.http, ['host', 'port', 'maxRequestBodyBytes'], 'http')
    if (config.http.host !== undefined && (typeof config.http.host !== 'string' || !config.http.host)) throw new MonoripperError('INVALID_CONFIG', 'Invalid http.host')
    positive(config.http.port, 'http.port', true)
    if ((config.http.port ?? 0) > 65535) throw new MonoripperError('INVALID_CONFIG', 'http.port exceeds 65535')
    positive(config.http.maxRequestBodyBytes, 'http.maxRequestBodyBytes')
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

export async function loadApp(filename: string): Promise<Pick<ServeOptions, 'app' | 'root'>> {
  const path = resolve(filename)
  const module = await import(pathToFileURL(path).href)
  const app = module.default ?? module.app
  validateApp(app)
  return { app: structuredClone(app), root: dirname(path) }
}

/** Trusted TypeScript/JavaScript config. No automatic file discovery or config-file watch. */
export async function loadConfig(filename: string, overrides: Partial<RuntimeConfig> = {}): Promise<ServeOptions> {
  const path = resolve(filename)
  const original = (await import(pathToFileURL(path).href)).default as RuntimeConfig
  const keys = ['app', 'initial', 'http', 'lifecycle', 'env']
  assertKeys(original, keys, 'config')
  validateRuntimeConfig(original)
  assertKeys(overrides, keys, 'override')
  validateRuntimeConfig({ initial: overrides.initial ?? {}, ...overrides })
  const config: RuntimeConfig = {
    ...original, ...overrides,
    initial: structuredClone(overrides.initial ?? original.initial),
    http: { ...original.http, ...overrides.http },
    lifecycle: { ...original.lifecycle, ...overrides.lifecycle },
    env: { ...original.env, ...overrides.env },
  }
  validateRuntimeConfig(config)
  if (typeof config.app !== 'string' || !config.app) throw new MonoripperError('INVALID_CONFIG', 'config.app must be a manifest path')
  const app = await loadApp(resolve(dirname(path), config.app))
  return { ...config, ...app }
}
