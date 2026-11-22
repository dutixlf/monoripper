import type { AnyElysia } from 'elysia'

export interface Ownership { method: string; path: string }
export interface ContextSpec {
  entry: string
  /** Optional directory boundary for the import checker. Defaults to the entry's directory, or the file if siblings share it. */
  root?: string
  /** Gateway routes. An empty list declares a background context: lifecycle hooks only, no ingress. */
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
export interface ServiceFetchInit extends RequestInit {
  /** The incoming request whose trace and remaining deadline the call inherits. */
  request?: Request
  /** Identity claims for the target context; only names allowed by `services.claims` arrive. */
  claims?: Record<string, string>
}
/** Explicit calls to other contexts through the gateway. Paths are routed by ownership like public requests. */
export interface Services { fetch(path: string, init?: ServiceFetchInit): Promise<Response> }
export interface ContextDefinition {
  /** `signal` aborts when the replica starts stopping; use it to end background loops started in onStart. */
  create(input: { app: AnyElysia; resources: ResourceAccess; signal: AbortSignal; services: Services }): AnyElysia | Promise<AnyElysia>
  stop?(): void | Promise<void>
  /** Prometheus text exposition for this replica. The runtime adds `context` and `worker` labels. */
  metrics?(): string | Promise<string>
}
export interface ResourceDefinition<T> {
  start(input: { env: NodeJS.ProcessEnv; context: string }): T | Promise<T>
  stop?(value: T): void | Promise<void>
}
export interface RuntimeConfig extends RuntimeSettings {
  /** Source mode: manifest module path, resolved relative to the config file. */
  app: string
  release?: never
}
/** Release mode: the runtime serves extracted releases instead of a source checkout. */
export interface ReleaseRuntimeConfig extends RuntimeSettings {
  /**
   * Bootstrap release for new state: a release archive or `release.json` path (relative to the config file),
   * or `<project>@sha256:<hex>` fetched from `registry`. Existing state keeps its deployed releases.
   */
  release: string
  app?: never
  /** Release origin for deployments. Only digests are requested from it; deploy requests cannot name URLs. */
  registry?: { url: string; tokenEnv: string; caFile?: string }
}
export interface RuntimeSettings {
  /** Processes this node may run at once, including draining replicas and deployment candidates. Default and maximum 64; 0 places every replica on node agents. */
  capacity?: { maxReplicas?: number }
  /**
   * Multi-node: node agents send heartbeats and `services.fetch` calls here, over HTTPS with one shared cluster credential.
   * The gateway verifies agent certificates against `caFile`. Release mode only.
   */
  cluster?: { host?: string; port?: number; tls: { certFile: string; keyFile: string }; caFile: string; tokenEnv: string; heartbeatTimeoutMs?: number }
  /** Claim names a context may pass to another context with `services.fetch`. Others are dropped. Default: none. */
  services?: { claims?: string[] }
  /** Autoscaler timing. Policies are set per context with SetAutoscale; nothing scales without one. */
  autoscale?: { intervalMs?: number; upWindowMs?: number; downWindowMs?: number; cooldownMs?: number; maxStep?: number }
  initial: Record<string, { replicas: number }>
  http?: {
    host?: string; port?: number; maxRequestBodyBytes?: number
    /** Peers (IP or CIDR) allowed to supply X-Forwarded-For/X-Real-IP and other X-Forwarded-* headers. */
    trustedProxies?: string[]
    /**
     * Relayed WebSocket limits. Defaults: 1 MiB messages, 1024 sockets, 120 s idle with automatic pings, and
     * 4 × maxMessageBytes buffered per socket in each of the gateway and the replica before it closes with 1013.
     */
    websocket?: { maxMessageBytes?: number; maxConnections?: number; idleTimeoutSeconds?: number; maxBufferedBytes?: number }
  }
  /** Unauthenticated /-/healthz, /-/readyz and /-/metrics listener. Keep it off the public network. */
  admin?: { host?: string; port?: number }
  /** `json` pipes worker output into one JSON object per line with `context` and `worker` fields. */
  logging?: { format?: 'text' | 'json' }
  lifecycle?: { startupTimeoutMs?: number; shutdownTimeoutMs?: number; requestTimeoutMs?: number }
  recovery?: { maxRestarts?: number; backoffMs?: number }
  environment?: string
  dataDir?: string
  /** Without `tls`, control binds loopback only. With it, any host is allowed and clients must verify the certificate. */
  control?: { host?: string; port?: number; tokenEnv: string; tls?: { certFile: string; keyFile: string } }
  env?: Record<string, string>
}
interface ServeHooks {
  /** Entries and tsconfig resolve against this directory, not the process cwd. */
  root?: string
  /** Cancel startup only. After serve resolves, use Runtime.stop(). Not a config-file option. */
  startupSignal?: AbortSignal
  /** Operator-only diagnostic sink. Messages may contain sensitive application data; redact before logging. */
  onDiagnostic?: (event: { context: string; code: string; message: string }) => void
}
export interface ServeOptions extends RuntimeSettings, ServeHooks { app: AppDefinition; release?: never }
export interface ReleaseServeOptions extends RuntimeSettings, ServeHooks {
  /** See ReleaseRuntimeConfig.release; relative paths resolve against `root`. */
  release: string
  app?: never
  registry?: ReleaseRuntimeConfig['registry']
}

/** Internal union shape after validation; public callers use ServeOptions or ReleaseServeOptions. */
export type RuntimeOptions = RuntimeSettings & ServeHooks & { app?: AppDefinition; release?: string; registry?: ReleaseRuntimeConfig['registry'] }

export const defineApp = (app: AppDefinition): AppDefinition => app
export const defineContext = (context: ContextDefinition): ContextDefinition => context
export const defineResource = <T>(resource: ResourceDefinition<T>): ResourceDefinition<T> => resource
export function defineConfig(config: RuntimeConfig): RuntimeConfig
export function defineConfig(config: ReleaseRuntimeConfig): ReleaseRuntimeConfig
export function defineConfig(config: RuntimeConfig | ReleaseRuntimeConfig) { return config }

export class MonoripperError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MonoripperError'
  }
}
