export * from './definitions'
export { serve, type Runtime } from './runtime'
export { checkApp, type ImportDiagnostic } from './check'
export { loadConfig } from './config'
import { serve } from './runtime'

export type { ControlStatus, Operation, SetContextRequest } from './control-types'
export type { ControlClient, ControlClientOptions } from './control-client'
export async function connectControl(options: import('./control-client').ControlClientOptions) {
  const { createControlClient } = await import('./control-client')
  return createControlClient(options)
}

export const monoripper = { serve }
