#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { loadApp, loadConfig } from './config'
import { checkApp } from './check'
import { serve } from './runtime'
import { MonoripperError, type RuntimeConfig } from './definitions'

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === '--help' || command === 'help' || !command) {
    console.log('monoripper serve --config <file> [--host <host>] [--port <port>]\nmonoripper check --app <manifest>')
    return
  }
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
  console.log(JSON.stringify({ event: 'listening', url: runtime.url.href, workers: runtime.status() }))
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof MonoripperError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'Command failed')
    process.exitCode = 1
  })
}
