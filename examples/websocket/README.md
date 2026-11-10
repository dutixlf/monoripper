# WebSocket example

From the repository root:

```sh
bun src/cli.ts check --app examples/websocket/app.ts
bun src/cli.ts serve --config examples/websocket/monoripper.config.ts
```

In a second terminal, subscribe and then trigger a change:

```sh
bun -e "const ws = new WebSocket('ws://127.0.0.1:3000/api/live/updates'); ws.onmessage = e => console.log(e.data)"
curl -X POST -H 'content-type: application/json' -d '{"reason":"added"}' http://127.0.0.1:3000/api/live/notify
```

The subscriber prints `{"type":"hello",...}` and then `{"type":"servers.changed","reason":"added"}`.

- The context declares `{ method: 'GET', path: '/api/live/*' }`. WebSocket upgrades match ownership as GET.
- The route is plain Elysia `.ws()` in a typed plugin, mounted with `app.use()`. Do not call `.listen()`.
- `server.publish()` reaches subscribers of the same replica only. Each replica is a separate process.
  With several replicas, deliver change events to every replica (for example PostgreSQL `LISTEN/NOTIFY` in a resource) and publish locally.
- When the replica drains or the runtime stops, clients receive close code 1001. When a replica exits, they receive 1012. Reconnect on both.
