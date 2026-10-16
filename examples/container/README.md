# Local container example

This e01s03 example embeds a small application in the image. It is not the future release registry.
Verified target: Linux amd64, rootless Podman 5.8.7, Bun 1.3.13 on Debian/glibc.

## Build and run

Run these commands from the repository root with Bun and rootless Podman available.
On NixOS, use `nix shell nixpkgs#bun nixpkgs#podman`. No NixOS configuration change is required
when subordinate UID/GID mappings, newuidmap/newgidmap and cgroup delegation already work.

The scoped test policy rejects other remote image repositories. It permits unsigned `oven/bun`
images because the Dockerfile pins the verified immutable manifest digest. It also permits local
build outputs. It does not modify system policy files or prove provenance beyond that digest.
If your environment requires signed-image verification, use its approved policy instead.
Automated tests preserve configured operator policies and use this fallback only when none exists.

```sh
podman build --signature-policy tests/container/policy.json -t localhost/monoripper:demo .
secret_file=$(mktemp)
chmod 600 "$secret_file"
bun -e 'console.log(crypto.randomUUID() + crypto.randomUUID())' > "$secret_file"
podman secret create monoripper-demo-control "$secret_file"
rm "$secret_file"
podman volume create monoripper-demo-state
podman run -d --name monoripper-demo --pull=never \
  --userns=keep-id:uid=1000,gid=1000 --user=1000:1000 \
  --read-only --cap-drop=all --security-opt=no-new-privileges \
  --memory=512m --cpus=1 --pids-limit=128 \
  --tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m \
  --secret monoripper-demo-control,type=mount,target=monoripper-control,uid=1000,gid=1000,mode=0400 \
  -v monoripper-demo-state:/var/lib/monoripper:rw \
  -p 127.0.0.1:3000:3000 localhost/monoripper:demo
curl http://127.0.0.1:3000/api/user/status
```

The final image runs as UID/GID 1000, without source checkout or test PostgreSQL packages.
The gateway listens on container port 3000. Only that port is published on host loopback.
Workers and authenticated gRPC listen only on container loopback. Do not publish port 50051.

## Administer through exec

```sh
podman exec monoripper-demo sh /app/example/control.sh status
podman exec monoripper-demo sh /app/example/control.sh scale --context user --replicas 3 --wait
podman exec monoripper-demo sh /app/example/control.sh scale --context billing --replicas 1 --wait
podman exec monoripper-demo sh /app/example/control.sh scale --context user --replicas 0 --wait
podman stop --time=5 monoripper-demo
podman rm monoripper-demo
```

Run the same `podman run` command to recreate the container. Keep the same volume and secret.
Saved desired counts take priority over initial defaults. One controller owns one volume.
The five-second external stop grace exceeds the configured two-second worker shutdown limit.
Secret values do not appear in CLI arguments, image layers, container env metadata or state.
Engine access is an operator privilege. Application code is trusted and can read shared mounts;
removing the credential from worker environment variables is not a secret filesystem sandbox.

CAUTION: Removing the volume deletes the saved desired state and operation history.
Do not remove it when you intend to recreate the runtime.
When finished, explicitly remove only the demo resources you no longer need:

```sh
podman volume rm monoripper-demo-state
podman secret rm monoripper-demo-control
podman image rm localhost/monoripper:demo
```

## Automated checks

```sh
bun run test:container
```

The suites build and run real containers with isolated names, volumes and generated secrets.
They verify boundaries, scale/recovery, response-body drain, recreation, hard kill and startup SIGTERM.
Missing Podman, unsupported platforms or broken rootless prerequisites fail instead of silently skipping.
Cleanup removes test-owned containers, secrets, volumes and image tags. Normal base/build caches remain.

On NixOS sessions with a private D-Bus, Podman can fail to create delegated systemd cgroups.
Use the canonical user bus for this command only:

```sh
DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus" \
  nix shell nixpkgs#podman --command bun run test:container
```

Remote TLS control, image updates without interruption, production registry bootstrap and other
platforms are not part of this example. Arbitrary blocking config code and stalled kernel I/O
cannot be cancelled safely. The container engine remains the final bounded shutdown mechanism.
