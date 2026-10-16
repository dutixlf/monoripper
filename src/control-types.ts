export type OperationPhase = 'accepted' | 'applying' | 'succeeded' | 'failed'
export interface ControlError { code: string; message: string }
export interface Operation {
  id: string
  requestId: string
  context: string
  replicas: number
  revision: number
  phase: OperationPhase
  createdAt: number
  updatedAt: number
  error?: ControlError
}
export interface StoredOperation extends Operation { payloadHash: string; previousReplicas: number }
export interface SetContextRequest {
  project: string
  environment: string
  requestId: string
  expectedRevision: number
  context: string
  replicas: number
}
export interface WorkerStatus { context: string; pid: number; ready: boolean; draining?: boolean }
export interface ControlStatus {
  project: string
  environment: string
  revision: number
  persistent: boolean
  healthy: boolean
  contexts: { name: string; desiredReplicas: number; readyReplicas: number; restarts: number; error?: ControlError }[]
  workers: WorkerStatus[]
}
export function publicOperation(stored: StoredOperation): Operation {
  const { payloadHash: _hash, previousReplicas: _previous, ...operation } = stored
  return structuredClone(operation)
}
