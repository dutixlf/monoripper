#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadApp, loadRuntimeConfig } from './config'
import { checkApp } from './check'
import { serve } from './runtime'
import { MonoripperError, type RuntimeSettings } from './definitions'
import type { Operation } from './control-types'
import { randomUUID } from 'node:crypto'

const help = `monoripper serve --config <file> [--host <host>] [--port <port>]
monoripper check --app <manifest>
monoripper pack --app <manifest> --out <release.tar.gz> [--label <label>]
monoripper publish <release.tar.gz> --registry <url> [--token-env <name>] [--ca-file <pem>] [--output <release.json>]
monoripper registry --config <file>
monoripper node --config <file>
Control (add --ca-file <pem> [--server-name <name>] or --tls for a TLS controller):
monoripper status|scale|operation|deploy|autoscale --controller <host:port> --project <name> [--environment <name>] [--token-env <name>]
  scale --context <name> --replicas <count> [--wait]
  deploy --release <release.json|sha256:...> --contexts <a,b> [--replicas <count>] [--request-id <base>] [--wait]
  autoscale --context <name> (--min <n> --max <n> --target-in-flight <n> | --disable)
  operation --id <operationId> [--wait]`

async function writeAtomically(path: string, text: string) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try { await writeFile(temporary, text, { mode: 0o644 }); await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
}

async function releaseDigest(reference: string): Promise<string> {
  if (/^sha256:[a-f0-9]{64}$/.test(reference)) return reference
  const record = JSON.parse(await readFile(reference, 'utf8')) as { digest?: unknown }
  if (typeof record.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.digest)) throw new MonoripperError('INVALID_COMMAND', '--release needs a digest or a release.json written by publish')
  return record.digest
}

async function remote(command: string, args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: {
    controller: { type: 'string' }, project: { type: 'string' }, environment: { type: 'string' },
    'token-env': { type: 'string' }, context: { type: 'string' }, replicas: { type: 'string' },
    'request-id': { type: 'string' }, 'expected-revision': { type: 'string' }, id: { type: 'string' },
    wait: { type: 'boolean' }, 'timeout-ms': { type: 'string' }, release: { type: 'string' }, contexts: { type: 'string' },
    'ca-file': { type: 'string' }, 'server-name': { type: 'string' }, tls: { type: 'boolean' },
    min: { type: 'string' }, max: { type: 'string' }, 'target-in-flight': { type: 'string' }, disable: { type: 'boolean' },
  } })
  if (!values.controller || !values.project) throw new MonoripperError('INVALID_COMMAND', 'Control commands require --controller and --project')
  const token = process.env[values['token-env'] ?? 'MONORIPPER_CONTROL_TOKEN']
  if (!token) throw new MonoripperError('INVALID_CONFIG', 'Control credential environment variable is not set')
  const timeout = values['timeout-ms'] === undefined ? 30_000 : Number(values['timeout-ms'])
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 0x7fffffff) throw new MonoripperError('INVALID_COMMAND', 'Invalid --timeout-ms')
  const tls = values['ca-file'] || values['server-name'] || values.tls
    ? { ...(values['ca-file'] ? { ca: await readFile(values['ca-file'], 'utf8') } : {}), ...(values['server-name'] ? { serverName: values['server-name'] } : {}) }
    : undefined
  const { createControlClient } = await import('./control-client')
  const client = createControlClient({ address: values.controller, project: values.project, environment: values.environment, token, ...(tls ? { tls } : {}) })
  try {
    if (command === 'status') { console.log(JSON.stringify(await client.getStatus())); return }
    if (command === 'autoscale') {
      if (!values.context) throw new MonoripperError('INVALID_COMMAND', 'Use autoscale --context <name> (--min --max --target-in-flight | --disable)')
      const policy = values.disable ? undefined : { min: Number(values.min), max: Number(values.max), targetInFlight: Number(values['target-in-flight']) }
      console.log(JSON.stringify(await client.setAutoscale(values.context, policy)))
      return
    }
    if (command === 'deploy') {
      if (!values.release || !values.contexts) throw new MonoripperError('INVALID_COMMAND', 'Use deploy --release <release.json|digest> --contexts <a,b>')
      const release = await releaseDigest(values.release)
      const contexts = values.contexts.split(',').map(name => name.trim()).filter(Boolean)
      if (!contexts.length || new Set(contexts).size !== contexts.length) throw new MonoripperError('INVALID_COMMAND', 'Invalid --contexts')
      const replicas = values.replicas === undefined ? undefined : Number(values.replicas)
      const base = values['request-id'] ?? crypto.randomUUID()
      // One operation per context; atomic group deployment is not promised. Each request uses the latest revision.
      const accepted: Operation[] = []
      for (const context of contexts) {
        const requestId = `${base}:${context}`
        const expectedRevision = (await client.getStatus()).revision
        console.error(`Deploy requestId: ${requestId} expectedRevision: ${expectedRevision}`)
        try {
          const operation = await client.setContext({ context, release, requestId, expectedRevision, ...(replicas !== undefined ? { replicas } : {}) })
          console.error(`Deploy operation: ${operation.id} context: ${context}`)
          accepted.push(operation)
        } catch (error) {
          if (!accepted.length) throw error
          console.error(`Deploy of ${context} was not accepted: ${error instanceof Error ? error.message : 'error'}`)
          process.exitCode = 1
        }
      }
      const results = values.wait ? await Promise.all(accepted.map(operation => client.waitOperation(operation.id, timeout))) : accepted
      console.log(JSON.stringify({ release, operations: results }))
      if (results.some(operation => operation.phase === 'failed')) process.exitCode = 1
      return
    }
    if (command === 'operation') {
      if (!values.id) throw new MonoripperError('INVALID_COMMAND', 'Use operation --id <operationId>')
      const result = values.wait ? await client.waitOperation(values.id, timeout) : await client.getOperation(values.id)
      console.log(JSON.stringify(result))
      if (result.phase === 'failed') process.exitCode = 1
      return
    }
    if (!values.context || values.replicas === undefined) throw new MonoripperError('INVALID_COMMAND', 'Use scale --context <name> --replicas <count>')
    const requestId = values['request-id'] ?? randomUUID()
    const expectedRevision = values['expected-revision'] === undefined ? (await client.getStatus()).revision : Number(values['expected-revision'])
    console.error(`Control requestId: ${requestId} expectedRevision: ${expectedRevision}`) // Keep the complete retry identity if the response is lost.
    const operation = await client.setContext({ context: values.context, replicas: Number(values.replicas), expectedRevision, requestId })
    const result = values.wait ? await client.waitOperation(operation.id, timeout) : operation
    console.log(JSON.stringify(result))
    if (result.phase === 'failed') process.exitCode = 1
  } finally { client.close() }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === '--help' || command === 'help' || !command) { console.log(help); return }
  if (['status', 'scale', 'operation', 'deploy', 'autoscale'].includes(command)) return remote(command, args)
  if (command === 'pack') {
    const { values } = parseArgs({ args, strict: true, options: { app: { type: 'string' }, out: { type: 'string' }, label: { type: 'string' } } })
    if (!values.app || !values.out) throw new MonoripperError('INVALID_COMMAND', 'Use pack --app <manifest> --out <release.tar.gz>')
    const { pack } = await import('./release')
    console.log(JSON.stringify(await pack({ app: values.app, out: values.out, ...(values.label ? { label: values.label } : {}) })))
    return
  }
  if (command === 'publish') {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
      registry: { type: 'string' }, 'token-env': { type: 'string' }, 'ca-file': { type: 'string' }, output: { type: 'string' } } })
    if (positionals.length !== 1 || !values.registry) throw new MonoripperError('INVALID_COMMAND', 'Use publish <release.tar.gz> --registry <url>')
    const token = process.env[values['token-env'] ?? 'MONORIPPER_REGISTRY_TOKEN']
    if (!token) throw new MonoripperError('INVALID_CONFIG', 'Registry write credential environment variable is not set')
    const { publishRelease } = await import('./registry-client')
    const result = await publishRelease({ url: values.registry, token, ...(values['ca-file'] ? { ca: await readFile(values['ca-file'], 'utf8') } : {}) },
      new Uint8Array(await readFile(positionals[0]!)))
    const record = { schemaVersion: 1, project: result.project, digest: result.digest, ...(result.label ? { label: result.label } : {}), bytes: result.bytes }
    if (values.output) await writeAtomically(resolve(values.output), JSON.stringify(record, null, 2) + '\n')
    console.log(JSON.stringify({ ...record, created: result.created }))
    return
  }
  if (command === 'registry' || command === 'node') return longRunning(command, args)
  if (command !== 'check' && command !== 'serve') throw new MonoripperError('INVALID_COMMAND', `Not implemented: ${command}`)
  const { values } = parseArgs({ args, strict: true, options: {
    config: { type: 'string' }, app: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' },
  } })
  if (command === 'check') {
    if (!values.app || values.config || values.host || values.port) throw new MonoripperError('INVALID_COMMAND', 'Use check --app <manifest>')
    const settings = await loadApp(values.app)
    const errors = checkApp(settings.app, { root: settings.root })
    for (const error of errors) console.error(`${error.file}:${error.line}:${error.column} ${error.code}: ${error.message}`)
    if (errors.length) process.exitCode = 1
    else console.log('Import boundaries: PASS')
    return
  }
  if (!values.config || values.app) throw new MonoripperError('INVALID_COMMAND', 'Use serve --config <file>')
  const overrides: Partial<RuntimeSettings> = {}
  if (values.host !== undefined || values.port !== undefined) {
    overrides.http = {
      ...(values.host !== undefined ? { host: values.host } : {}),
      ...(values.port !== undefined ? { port: Number(values.port) } : {}),
    }
  }
  const startup = new AbortController()
  let runtime: Awaited<ReturnType<typeof serve>> | undefined
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    startup.abort()
    if (runtime) runtime.stop().then(() => process.exit(0), error => {
      console.error(error instanceof Error ? error.message : 'Shutdown failed')
      process.exit(1)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  try {
    const settings = await loadRuntimeConfig(values.config, overrides)
    if (stopping) return
    runtime = await serve({ ...settings, startupSignal: startup.signal })
    if (stopping) { await runtime.stop(); return }
    console.log(JSON.stringify({ event: 'listening', url: runtime.url.href, workers: runtime.status(), ...(runtime.controlAddress ? { controlAddress: runtime.controlAddress } : {}), ...(runtime.adminUrl ? { adminUrl: runtime.adminUrl.href } : {}) }))
  } catch (error) {
    if (!(stopping && error instanceof MonoripperError && error.code === 'SHUTTING_DOWN')) throw error
  } finally {
    if (!runtime) { process.off('SIGTERM', shutdown); process.off('SIGINT', shutdown) }
  }
}

/** Registry and node agent: start from a config file, stop cleanly on SIGTERM/SIGINT. */
async function longRunning(command: 'registry' | 'node', args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: { config: { type: 'string' } } })
  if (!values.config) throw new MonoripperError('INVALID_COMMAND', `Use ${command} --config <file>`)
  if (command === 'node') throw new MonoripperError('INVALID_COMMAND', 'Not implemented: node')
  const { loadRegistryConfig, startRegistry } = await import('./registry')
  const service: { url: URL; stop(): Promise<void> } = await startRegistry(await loadRegistryConfig(values.config))
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    service.stop().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : 'Shutdown failed'); process.exit(1) })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  console.log(JSON.stringify({ event: 'listening', role: command, url: service.url.href }))
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof MonoripperError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'Command failed')
    process.exitCode = 1
  })
}
