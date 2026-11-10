# Monoripper — plan and design

Status: **e01s01/e01s02 local control, e01s03 container lifecycle and e01s04 WebSocket relay implemented, automated checks passed, awaiting UAT**.
Current run instructions and implemented API: [project README](../README.md). Other documents also describe future stages.
Purpose: record agreements and provide an implementation baseline without repeated design work.

Monoripper is one npm package for selected Elysia application contexts, replica management, and code updates without container replacement.
The target audience is small projects that outgrow one process but do not yet need a general cluster platform.

## Reading guide

1. [Product scope](product/SCOPE_LATEST.yaml) — commitments and exclusions.
2. [Architecture and principles](tech-architecture/tech-stack.md) — components, state, and failure boundaries.
3. [Application API](design/application-api.md) — Elysia, contexts, resources, and the linter.
4. [Execution and control](design/runtime.md) — processes, gRPC, balancing, multiple nodes, and autoscaling.
5. [Releases and CI/CD](design/releases.md) — registry, packaging, safe version changes, and containers.
6. [Roadmap](ROADMAP.md) — vertical slices and readiness criteria.

Design examples are **target API / pseudocode**, not a complete list of implemented features.
serve/check, protobuf control scale/status/operation, persistent desired state, and worker recovery work. Registry/deploy are not implemented yet.
Bun 1.3.13, Elysia 1.4.30, gRPC JS 1.14.6, and TypeScript 5.9.3 are verified and pinned.

## Confirmed decisions

- One installable package. Internal components do not require separate products.
- First adapter: Elysia. First runtime: Bun.
- Each route has one context owner. A context can have multiple replicas.
- Shared modules contain shared logic. The prototype protects boundaries with a linter and explicit errors.
- Contexts can be enabled, disabled, and replicated through the internal gRPC API.
- Configuration persistence, balancing, multiple nodes, and request context propagation are required.
- Container operation must not require a Docker socket or Docker-in-Docker.
- Context implementations must be replaceable during operation.
- Releases come from a private registry. Git is not part of the runtime/deployment protocol.
- CI/CD separates build, publish, and deploy.

## Accepted base architecture

After considering a shared runtime, the user confirmed the original process model:

- One context replica is one Bun child process. Module isolation and safe version changes take priority over runtime memory savings.
- One controller node and one public ingress. Full controller HA is deferred.
- Routing uses explicit `owns`: a path prefix or exact path plus HTTP method.
- One release contains the entire application build. Selected contexts update independently.
- The first delivery supports HTTP request/response. e01s04 adds relayed WebSockets; endless HTTP streams remain outside the prototype.
- The registry belongs to the same package but can run as a separate process with on-disk archives.
- Cross-context calls use explicit HTTP through an SDK, not transparent function serialization.
- Autoscaling and multiple nodes follow local lifecycle and verifiable updates.

## Configuration and next step

Each installation/node needs a user config file with its own settings, not one mandatory shared configuration.
Application/release descriptions, local node settings, and persistent desired state must remain separate.
Explicit TS/JS config is implemented: defaults → config → explicit CLI overrides, without shared mutable configuration.
Controller/local-policy interaction follows in later stages.

Current step: UAT of the local and [container example](../examples/container/README.md), then detailed e02 registry/release work.
Container control uses authenticated engine exec per [ADR 0001](adr/0001-container-exec-control.md), not remote TLS/RBAC.
The full external backend `src/app.ts` and a separate tags context passed real migrations/CRUD on embedded PostgreSQL 18.
No publication or registry deployment occurred. OAuth and other domain flows are not verified.

Document structure check: `python3 scripts/check-specs.py`.
Results: [WebSocket relay](verifications/e01s04-verify.yaml), [container lifecycle](verifications/e01s03-verify.yaml), [local control](verifications/e01s02-verify.yaml), [PostgreSQL follow-up](verifications/embedded-postgres-verify.yaml), [initial prototype](verifications/e01s01-verify.yaml), [historical plan review](verifications/planning.md).
