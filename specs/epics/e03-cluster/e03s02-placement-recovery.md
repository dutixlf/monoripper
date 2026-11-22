# e03s02 — Node placement and recovery

## 1. Purpose
Place replicas on compatible healthy nodes with capacity and recover when nodes or the controller fail.

## 2. User story
As an operator, I connect nodes and scale; Monoripper spreads replicas, replaces lost ones and never revives outdated ones.

## 3. Status and complexity
Implemented, automated checks passing, user UAT pending. 8 BCP, P0 risk from partitions and duplicate processes.

## 4. Dependencies
e03s01 agents and cluster endpoint.

## 5. Inputs
Heartbeats (`instance`, `id`, `url`, `maxReplicas`, `compatibility`, `generation`, workers), `capacity.maxReplicas` per node.

## 6. Outputs
`status.nodes` with health, capacity and replicas; stop lists in heartbeat replies.

## 7. ADDED requirements
- Placement picks the node with the fewest replicas among this process and healthy compatible agents with free slots, ties by node id, skipping unreachable ones.
- Missing heartbeats for `heartbeatTimeoutMs` withdraw the node's replicas from routing; recovery places replacements elsewhere.
- A reconnecting or restarted agent is told to stop replicas the controller no longer counts; a new controller stops all replicas it did not assign.
- Startup without enough nodes waits for capacity; a connecting node triggers placement with a fresh restart budget.
- No suitable node → `CAPACITY_EXCEEDED`; desired growth rolls back.

## 8. Invariants
Withdrawal from routing does not prove a process stopped. During a partition a context can run more processes than desired; exactly-once and strict singletons are not promised.

## 9. Startup interface
Node `heartbeatMs`, controller `cluster.heartbeatTimeoutMs`.

## 10. Storage
Assignments are not persisted; desired counts are. The controller re-places from desired state.

## 11. Separation rationale
Agent ids plus random worker ids and an agent `instance` replace a persisted generation counter: unknown means outdated.

## 12. Errors
`CAPACITY_EXCEEDED`, `NODE_UNREACHABLE`, `REGISTRY_UNAVAILABLE` when a node cannot fetch an uncached digest.

## 13. Security
Heartbeats require the cluster credential and must match the controller's project and environment.

## 14. Compatibility
Agents keep serving when the controller is down; the gateway is unavailable then (no controller HA).

## 15. Implementation steps
1. Heartbeat loss, reconnect, registry outage, capacity, controller restart → verify: `bun test tests/e2e/node-recovery.test.ts`.

## 16. Test data
Controller and two agents as separate CLI processes; SIGSTOP/SIGCONT partition; registry stopped and restarted on the same port.

## 17. Acceptance criteria
- SIGSTOP node-b: it turns unhealthy, its replica is replaced on node-c while the old process still runs; after SIGCONT the old replica stops.
- With the registry down a new digest fails before its switch; after restart it deploys.
- Scaling beyond 1 + 2 + 2 slots fails and keeps two replicas. After a controller SIGKILL the new controller stops the old remote replicas and restores two ready replicas.

## 18. Manual demonstration
Pause an agent with SIGSTOP in [examples/cluster](../../../examples/cluster/README.md) and watch `status`.

## 19. Out of scope
Fencing, consensus, controller HA, automatic node provisioning.

## 20. Gate and handoff
All entrypoints pass. Evidence: [e03-verify.yaml](../../verifications/e03-verify.yaml). User UAT pending.
