# zalo-bridge docs

| Document | Covers |
| --- | --- |
| [http-api.md](http-api.md) | The bridge's internal HTTP API (`/status`, `/kick`, `/login`, `/logout`, `/groups`, `/reactions`) |
| [collections.md](collections.md) | PocketBase collections the bridge reads and writes, with required fields and indexes |
| [sending-messages.md](sending-messages.md) | How to send text, files, replies and group messages through `zalo_outbox` |
| [session.md](session.md) | Login flow, session statuses and reconnect behavior |
| [pocketbase-hooks.md](pocketbase-hooks.md) | Example PocketBase JS hooks that call the bridge |

## How the pieces fit

```
 Zalo servers ◄──── zca-js ────► zalo-bridge ◄──── HTTP (x-bridge-secret) ──── PocketBase hooks / admin UI
                                   │    ▲
                    write messages │    │ read outbox, update status
                    & session      ▼    │
                                 PocketBase (superuser auth)
```

- The bridge logs in to PocketBase as a superuser and talks to it with the PocketBase JS SDK.
- PocketBase (or anything on the same host) calls the bridge's HTTP API to trigger sends and login/logout.
- Apps never talk to the bridge directly: they read `zalo_messages` / `zalo_session` and create `zalo_outbox` records in PocketBase.
