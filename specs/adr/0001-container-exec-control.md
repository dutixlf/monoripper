# ADR 0001: administer the first container through exec

Status: accepted by the user on 2026-10-16.

The existing control server permits loopback only. Exposing plaintext gRPC on a container network
would weaken that boundary. Adding remote TLS is a separate feature, not an image prerequisite.

For e01s03, keep gRPC on `127.0.0.1` inside the container. Run the control CLI through rootless
Podman exec. Mount the credential as a read-only secret, not an image layer or command argument.
Only the HTTP gateway is published. Engine access remains an operator privilege.

This explicitly replaces the earlier e01s03 private-network remote-control acceptance criterion.
Remote TLS/RBAC and cross-node control remain deferred. Exec does not provide remote API access.
Application modules remain trusted code, not a sandbox. Workers use the same container identity
and can access mounts available to that identity. Environment filtering is not filesystem isolation.

Use one persistent local volume per controller, a non-root UID/GID, and a pinned Debian/glibc base.
Do not add Docker sockets, privileged mode, host PID/network namespaces, or runtime package installs.
