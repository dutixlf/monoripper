export type OperationPhase = 'accepted' | 'applying' | 'succeeded' | 'failed'
export type OperationStep = 'preparing' | 'starting' | 'switching' | 'draining'
export interface ControlError { code: string; message: string }
export interface Operation {
  id: string
  requestId: string
  context: string
  replicas: number
  /** Target release digest of a deployment. Absent for source-mode scaling. */
  release?: string
  revision: number
  phase: OperationPhase
  /** Progress of an applying deployment. */
  step?: OperationStep
  createdAt: number
  updatedAt: number
  error?: ControlError
  /** A succeeded operation with a non-fatal problem, for example an old replica that missed its drain deadline. */
  warning?: ControlError
  /** Set when the autoscaler created the operation. */
  origin?: 'operator' | 'autoscaler'
}
export interface StoredOperation extends Operation { payloadHash: string; previousReplicas: number; previousRelease?: string }
export interface SetContextRequest {
  project: string
  environment: string
  requestId: string
  expectedRevision: number
  context: string
  /** Absent keeps the current desired count (a new context then defaults to 1). */
  replicas?: number
  /** Release digest to deploy (`sha256:<hex>`). Requires a release-mode runtime. */
  release?: string
}
export interface AutoscalePolicy { min: number; max: number; targetInFlight: number }
export interface SetAutoscaleRequest {
  project: string
  environment: string
  context: string
  /** Absent disables autoscaling for the context. */
  policy?: AutoscalePolicy
}
export interface WorkerStatus { context: string; pid: number; ready: boolean; draining?: boolean; release?: string; node?: string }
export interface NodeStatus { id: string; healthy: boolean; maxReplicas: number; replicas: number; lastSeenMs?: number }
export interface ControlStatus {
  project: string
  environment: string
  revision: number
  persistent: boolean
  healthy: boolean
  contexts: {
    name: string; desiredReplicas: number; readyReplicas: number; restarts: number; error?: ControlError
    release?: string; servingRelease?: string; lastGoodRelease?: string; autoscale?: AutoscalePolicy
  }[]
  workers: WorkerStatus[]
  nodes?: NodeStatus[]
}
export function publicOperation(stored: StoredOperation): Operation {
  const { payloadHash: _hash, previousReplicas: _previous, previousRelease: _release, ...operation } = stored
  return structuredClone(operation)
}
