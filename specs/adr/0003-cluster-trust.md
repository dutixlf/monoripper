# ADR 0003: one shared cluster credential over verified TLS

Status: accepted on 2026-11-22 under the user's authorization to complete the release plan.

Node agents and the controller authenticate each other with one shared secret (`x-monoripper-cluster-token`)
on HTTPS connections verified against a private CA. The controller verifies agent certificates with `cluster.caFile`;
agents verify the controller with `controller.caFile`.

Consequences:

- Every node that holds the credential is trusted with the whole cluster: it can serve any assigned context,
  impersonate another node's heartbeat, and call any context through services. A compromised node compromises the cluster.
- The CA must be private. A public CA would let any host with a public certificate receive gateway traffic once an
  agent advertised it.
- Agents never decide placement and never accept requests without the credential; worker ports stay on loopback.
- Replica identities are random per assignment, and each agent process has a random instance id. A controller stops
  replicas it does not know, which replaces a persisted generation counter.
- Per-node credentials, mutual TLS identities and RBAC are future work. Control (gRPC) keeps its own credential.
