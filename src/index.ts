export * from './definitions'
export { serve, type Runtime } from './runtime'
export { checkApp, type ImportDiagnostic } from './check'
export { loadConfig, loadRuntimeConfig } from './config'
export { requestClientAddress } from './client-ip'
export { requestContext, type RequestContext } from './request-context'
import { serve } from './runtime'
import type { RegistryConfig } from './registry'

export type { AutoscalePolicy, ControlStatus, NodeStatus, Operation, OperationStep, SetContextRequest, WorkerStatus } from './control-types'
export type { ControlClient, ControlClientOptions } from './control-client'
export type { PackResult, ReleaseManifest } from './release'
export type { Registry, RegistryConfig } from './registry'
export type { RegistryEndpoint } from './registry-client'

export async function connectControl(options: import('./control-client').ControlClientOptions) {
  const { createControlClient } = await import('./control-client')
  return createControlClient(options)
}
/** Builds a deterministic release archive from an app manifest. */
export async function pack(options: { app: string; out: string; label?: string }) {
  return (await import('./release')).pack(options)
}
/** Uploads a release archive; repeating identical bytes is safe. */
export async function publishRelease(endpoint: import('./registry-client').RegistryEndpoint, archive: Uint8Array) {
  return (await import('./registry-client')).publishRelease(endpoint, archive)
}
export async function startRegistry(config: RegistryConfig) {
  return (await import('./registry')).startRegistry(config)
}
export const defineRegistry = (config: RegistryConfig): RegistryConfig => config
export type { NodeAgent, NodeConfig } from './node-agent'
export const defineNode = (config: import('./node-agent').NodeConfig) => config
/** Runs a node agent in this process; `monoripper node --config` is the CLI equivalent. */
export async function startNode(config: import('./node-agent').NodeConfig) {
  return (await import('./node-agent')).startNode(config)
}

export const monoripper = { serve }
