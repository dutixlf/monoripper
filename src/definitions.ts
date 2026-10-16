import type { AnyElysia } from 'elysia'

export interface Ownership { method: string; path: string }
export interface ContextSpec {
  entry: string
  /** Optional directory boundary for the import checker. Defaults to the entry's directory, or the file if siblings share it. */
  root?: string
  owns: Ownership[]
  resources?: string[]
}
export interface AppDefinition {
  project: string
  contexts: Record<string, ContextSpec>
  resources?: Record<string, { entry: string; contexts: string[] }>
  tsconfig?: string
}
export interface ResourceAccess { get<T = unknown>(name: string): T }
export interface ContextDefinition {
  create(input: { app: AnyElysia; resources: ResourceAccess }): AnyElysia | Promise<AnyElysia>
  stop?(): void | Promise<void>
}
export interface ResourceDefinition<T> {
  start(input: { env: NodeJS.ProcessEnv; context: string }): T | Promise<T>
  stop?(value: T): void | Promise<void>
}
export interface RuntimeConfig {
  /** Manifest module path, resolved relative to the config file. */
  app: string
  initial: Record<string, { replicas: number }>
  http?: { host?: string; port?: number; maxRequestBodyBytes?: number }
  lifecycle?: { startupTimeoutMs?: number; shutdownTimeoutMs?: number; requestTimeoutMs?: number }
  recovery?: { maxRestarts?: number; backoffMs?: number }
  environment?: string
  dataDir?: string
  control?: { host?: '127.0.0.1' | '::1'; port?: number; tokenEnv: string }
  env?: Record<string, string>
}
export interface ServeOptions extends Omit<RuntimeConfig, 'app'> {
  app: AppDefinition
  /** Entries and tsconfig resolve against this directory, not the process cwd. */
  root?: string
  /** Operator-only diagnostic sink. Messages may contain sensitive application data; redact before logging. */
  onDiagnostic?: (event: { context: string; code: string; message: string }) => void
}

export const defineApp = (app: AppDefinition): AppDefinition => app
export const defineContext = (context: ContextDefinition): ContextDefinition => context
export const defineResource = <T>(resource: ResourceDefinition<T>): ResourceDefinition<T> => resource
export const defineConfig = (config: RuntimeConfig): RuntimeConfig => config

export class MonoripperError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MonoripperError'
  }
}
