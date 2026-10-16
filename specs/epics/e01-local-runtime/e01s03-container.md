# e01s03 — Container lifecycle

## 1. Purpose
Prove that container operation preserves Monoripper control over child processes.

## 2. User story
As a small-project operator, I run one container and manage its contexts without a Docker socket.

## 3. Status and complexity
Implemented, automated checks passing, user UAT pending. 3 BCP, P0 risk from process lifecycle and network boundaries.

## 4. Dependencies
e01s02, rootless Podman for tests, and a pinned Linux amd64 Debian/glibc Bun image.
User approved [exec-based administration](../../adr/0001-container-exec-control.md) instead of exposed private-network gRPC.

## 5. Inputs
Image, source fixture/initial application before e02, configuration, credentials, persistent volume, and resource limits.

## 6. Outputs
A running non-root runtime, loopback-only control through engine exec, and reproducible stop/restart.

## 7. ADDED requirements
- Contexts start and scale inside the container.
- The container needs no privileged mode, host PID namespace, or Docker socket.
- The state volume survives container recreation.
- SIGTERM to the main process stops workers and leaves no processes after container stop.

## 8. Invariants
CPU/RAM limits apply to the entire container. Do not promise separate memory or HA for contexts.

## 9. Startup interface
Use `serve --config` as the container entrypoint. Before e02, the example is embedded in the image.
Run status/scale/operation through `podman exec`, with a helper that reads the mounted secret inside the container.
The registry and production bootstrap releases remain e02 work.

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
Control binds only to container loopback and requires a credential. Do not publish its port.
Engine exec is an operator privilege, not remote API access. Worker code is trusted, not isolated from shared mounts.

## 14. Compatibility
The first target is Linux amd64 with glibc and rootless Podman. Verify authenticated CLI control through exec.
EXPOSE is not a firewall rule or port publication.

## 15. Implementation steps
1. Add a minimal image and network/security smoke → verify: `test -f tests/container/boundaries.sh && bash tests/container/boundaries.sh`.
2. Repeat gRPC lifecycle, stop, and volume restart → verify: `test -f tests/container/lifecycle.sh && bash tests/container/lifecycle.sh`.

## 16. Test data
Two contexts, persistent state, a slow request, limited memory, and a bounded stop timeout.

## 17. Acceptance criteria
- The real gRPC CLI through exec starts billing and changes user replicas inside the container.
- Run as non-root without Docker socket or privileged mode.
- Worker ports are inaccessible outside the container. Control requires a credential.
- Recreation with the same volume restores desired state.
- SIGTERM completes within the configured deadline without leftover worker processes.

## 18. Manual demonstration
Start the example, scale through the CLI, stop the container during a short request, and recreate it with the volume.
Demonstrate expected limitations when the entire container is lost.

## 19. Out of scope
Remote network control/TLS, zero-downtime image replacement, Kubernetes manifests, Docker-in-Docker, and separate context cgroups.

## 20. Gate and handoff
Both task entrypoints and the startup regression pass on real rootless Podman.
Evidence: [e01s03-verify.yaml](../../verifications/e01s03-verify.yaml).
User UAT remains pending. After the e01 gate, detail e02. Do not publish to npm/registry automatically.
Structure check: `python3 scripts/check-specs.py`.
