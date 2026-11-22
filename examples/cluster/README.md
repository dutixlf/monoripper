# Cluster example: one gateway, a node agent, bounded autoscaling

Prerequisite: the registry and `.monoripper/example-release.json` from [the release example](../releases/README.md), steps 1–3.
Run from the repository root with the same exports, plus a cluster credential shared by the controller and its agents:

```sh
export MONORIPPER_CLUSTER_TOKEN="$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')"

bun src/cli.ts serve --config examples/cluster/controller.config.ts   # terminal 1
bun src/cli.ts node --config examples/cluster/node.config.ts          # terminal 2

bun src/cli.ts status --controller 127.0.0.1:50051 --project example  # nodes: local and node-b, healthy
bun src/cli.ts scale --controller 127.0.0.1:50051 --project example --context user --replicas 3 --wait
bun src/cli.ts status --controller 127.0.0.1:50051 --project example  # user workers on local and node-b
curl -s http://127.0.0.1:3000/api/user/status                         # repeat: pids from both nodes

# Bounded autoscaling for user: manual scaling is rejected while the policy exists.
bun src/cli.ts autoscale --controller 127.0.0.1:50051 --project example --context user --min 1 --max 4 --target-in-flight 4
bun src/cli.ts autoscale --controller 127.0.0.1:50051 --project example --context user --disable
```

Partition drill: `kill -STOP <node pid>` turns node-b unhealthy after `heartbeatTimeoutMs`, and its replicas are replaced
where capacity allows while the paused processes still exist. `kill -CONT <node pid>` reconnects the agent, which then
stops the replicas the controller replaced. Strict singletons therefore need an external lock.

For real machines, issue certificates from a private CA for every agent address and the controller, keep the cluster port
on the private network, and treat every node holding the cluster credential as trusted ([ADR 0003](../../specs/adr/0003-cluster-trust.md)).
