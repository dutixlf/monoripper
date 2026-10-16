#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { loadApp, loadConfig } from './config'
import { checkApp } from './check'
import { serve } from './runtime'
import { MonoripperError, type RuntimeConfig } from './definitions'
import { randomUUID } from 'node:crypto'

async function remote(command: string, args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: {
    controller: { type: 'string' }, project: { type: 'string' }, environment: { type: 'string' },
    'token-env': { type: 'string' }, context: { type: 'string' }, replicas: { type: 'string' },
    'request-id': { type: 'string' }, 'expected-revision': { type: 'string' }, id: { type: 'string' },
    wait: { type: 'boolean' }, 'timeout-ms': { type: 'string' },
  } })
  if (!values.controller || !values.project) throw new MonoripperError('INVALID_COMMAND', 'Control commands require --controller and --project')
  const token = process.env[values['token-env'] ?? 'MONORIPPER_CONTROL_TOKEN']
  if (!token) throw new MonoripperError('INVALID_CONFIG', 'Control credential environment variable is not set')
  const timeout = values['timeout-ms'] === undefined ? 30_000 : Number(values['timeout-ms'])
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 0x7fffffff) throw new MonoripperError('INVALID_COMMAND', 'Invalid --timeout-ms')
  const { createControlClient } = await import('./control-client')
  const client = createControlClient({ address: values.controller, project: values.project, environment: values.environment, token })
  try {
    if (command === 'status') { console.log(JSON.stringify(await client.getStatus())); return }
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
  if (command === '--help' || command === 'help' || !command) {
    console.log('monoripper serve --config <file> [--host <host>] [--port <port>]\nmonoripper check --app <manifest>\nmonoripper status|scale|operation --controller <loopback:port> --project <name> [--environment <name>]\nscale --context <name> --replicas <count> [--wait]\noperation --id <operationId> [--wait]')
    return
  }
  if (['status', 'scale', 'operation'].includes(command)) return remote(command, args)
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
  const overrides: Partial<RuntimeConfig> = {}
  if (values.host !== undefined || values.port !== undefined) {
    overrides.http = {
      ...(values.host !== undefined ? { host: values.host } : {}),
      ...(values.port !== undefined ? { port: Number(values.port) } : {}),
    }
  }
  const runtime = await serve(await loadConfig(values.config, overrides))
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    runtime.stop().then(() => process.exit(0), error => {
      console.error(error instanceof Error ? error.message : 'Shutdown failed')
      process.exit(1)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  console.log(JSON.stringify({ event: 'listening', url: runtime.url.href, workers: runtime.status(), ...(runtime.controlAddress ? { controlAddress: runtime.controlAddress } : {}) }))
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof MonoripperError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'Command failed')
    process.exitCode = 1
  })
}
