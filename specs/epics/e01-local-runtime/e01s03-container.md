# e01s03 — Container lifecycle

## 1. Purpose
Prove that container operation preserves Monoripper control over child processes.

## 2. User story
As a small-project operator, I run one container and manage its contexts without a Docker socket.

## 3. Status and complexity
Draft, failing ledger. 3 BCP, P0 risk from process lifecycle and network boundaries.

## 4. Dependencies
e01s02, an available container engine for tests, and a verified Bun base image/digest.

## 5. Inputs
Image, source fixture/initial application before e02, configuration, credentials, persistent volume, and resource limits.

## 6. Outputs
A running non-root runtime, private control endpoint, and reproducible stop/restart.

## 7. ADDED requirements
- Contexts start and scale inside the container.
- The container needs no privileged mode, host PID namespace, or Docker socket.
- The state volume survives container recreation.
- SIGTERM to the main process stops workers and leaves no processes after container stop.

## 8. Invariants
CPU/RAM limits apply to the entire container. Do not promise separate memory or HA for contexts.

## 9. Startup interface
Proposed `serve --config`. Before e02, the fixture is embedded in the test image. The runtime registry is not implemented yet.
Production bootstrap releases are finalized in e02.

## 10. Storage
One controller uses one state volume with correct uid/gid and data directory permissions.
Secrets mounts are separate from image layers and state logs.

## 11. Separation rationale
The image pins the runtime environment. Later, immutable releases deliver the application.
Container tests verify signal, namespace, and network behavior absent from unit tests.

## 12. Errors
Status/logs expose inaccessible volumes, occupied ports, insufficient grace periods, and worker crashes.

## 13. Security
Non-root operation, minimal published ports, and no credentials in image layers or output.
Remote control is available only on the private test network with authorization.

## 14. Compatibility
The first target is Linux. Verify control connectivity between the container and test runner.
EXPOSE is not a firewall rule or port publication.

## 15. Implementation steps
1. Add a minimal image and network/security smoke → verify: `test -f tests/container/boundaries.sh && bash tests/container/boundaries.sh`.
2. Repeat gRPC lifecycle, stop, and volume restart → verify: `test -f tests/container/lifecycle.sh && bash tests/container/lifecycle.sh`.

## 16. Test data
Two contexts, persistent state, a slow request, limited memory, and a bounded stop timeout.

## 17. Acceptance criteria
- gRPC can start billing and change user replicas inside the container.
- Run as non-root without Docker socket or privileged mode.
- Worker ports are inaccessible outside the container. Control requires a credential.
- Recreation with the same volume restores desired state.
- SIGTERM completes within the configured deadline without leftover worker processes.

## 18. Manual demonstration
Start the example, scale through the CLI, stop the container during a short request, and recreate it with the volume.
Demonstrate expected limitations when the entire container is lost.

## 19. Out of scope
Zero-downtime image replacement, Kubernetes manifests, Docker-in-Docker, and separate context cgroups.

## 20. Gate and handoff
After the e01 gate, detail e02. Do not publish to npm/registry automatically.
Structure check: `python3 scripts/check-specs.py`.
