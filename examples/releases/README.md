# Release example: pack, publish, deploy, roll back

Run from the repository root. All state goes to the ignored `.monoripper/` directory.

```sh
# 1. Credentials: separate registry write (CI) and read (runtime) tokens, and the control token.
export MONORIPPER_REGISTRY_TOKEN="$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')"
export MONORIPPER_REGISTRY_READ_TOKEN="$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')"
export MONORIPPER_CONTROL_TOKEN="$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')"

# 2. Registry (terminal 1).
bun src/cli.ts registry --config examples/releases/registry.config.ts

# 3. Build v1 and v2 and publish both (terminal 2, same exports).
bun src/cli.ts pack --app examples/releases/app.ts --out .monoripper/v1.tar.gz --label v1
bun src/cli.ts pack --app examples/releases/app-v2.ts --out .monoripper/v2.tar.gz --label v2
bun src/cli.ts publish .monoripper/v1.tar.gz --registry http://127.0.0.1:4873/ --output .monoripper/example-release.json
bun src/cli.ts publish .monoripper/v2.tar.gz --registry http://127.0.0.1:4873/ --output .monoripper/example-release-v2.json

# 4. Release-mode runtime from v1 (terminal 3). It runs only what the registry delivered.
bun src/cli.ts serve --config examples/releases/runtime.config.ts
curl -s http://127.0.0.1:3000/api/user/status        # version v1

# 5. Deploy v2 to user only; billing stays on v1. New requests switch, running ones finish on v1.
bun src/cli.ts deploy --controller 127.0.0.1:50051 --project example --release .monoripper/example-release-v2.json --contexts user --wait
curl -s http://127.0.0.1:3000/api/user/status        # version v2, billing.caller "user", shared traceId

# 6. Roll back: deploy the retained v1 digest.
bun src/cli.ts deploy --controller 127.0.0.1:50051 --project example --release .monoripper/example-release.json --contexts user --wait
bun src/cli.ts status --controller 127.0.0.1:50051 --project example   # servingRelease / lastGoodRelease per context
```

Restart the runtime: it keeps the deployed releases from its state, not the bootstrap in the config.
Stop the registry and restart the runtime: cached releases still start; a new uncached digest fails before its switch.

`ci.yml` is a GitHub Actions example that builds once and moves the same `release.json` from staging to production.
For a controller on a private network, configure `control.tls` and pass `--ca-file` to the CLI.
