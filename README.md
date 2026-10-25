# zalo-bridge

A bridge between a personal Zalo account (via [zca-js](https://github.com/RFS-ADRENO/zca-js)) and [PocketBase](https://pocketbase.io).

- **Incoming:** every message the account receives (and, optionally, sends) is saved to the `zalo_messages` collection. Recalled messages are marked `recalled = true`.
- **Outgoing:** records added to `zalo_outbox` with `status = "pending"` are sent through Zalo, then marked `sent` or `failed`.
- **Session:** login state, the QR code to scan, and saved credentials live in a single `zalo_session` record, so a PocketBase UI can drive login/logout.

> ⚠️ zca-js is an unofficial API. Using it may get the Zalo account restricted — keep the send delay reasonable and avoid spam.

## Requirements

- [Bun](https://bun.sh) (runtime and build tool)
- A PocketBase instance with the collections described below and a superuser account for the bridge

## Setup

```bash
bun install
cp .env.example .env   # then fill in the values
bun run dev
```

On first start (with `ZALO_AUTO_QR_LOGIN=true`) the bridge generates a QR code and stores it in `zalo_session.qr_image` as a data URL. Scan it with the Zalo app on your phone and confirm. Credentials are saved to `zalo_session.credentials`, so later restarts log in automatically.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PB_URL` | `http://127.0.0.1:8090` | PocketBase URL |
| `PB_SUPERUSER_EMAIL` | — (required) | Superuser email used by the bridge |
| `PB_SUPERUSER_PASSWORD` | — (required) | Superuser password |
| `BRIDGE_HOST` | `127.0.0.1` | Host for the internal HTTP API |
| `BRIDGE_PORT` | `3939` | Port for the internal HTTP API |
| `BRIDGE_SECRET` | — (required, ≥ 16 chars) | Shared secret; PocketBase must send it in the `x-bridge-secret` header |
| `ZALO_SELF_LISTEN` | `true` | Also store messages sent by the account itself |
| `ZALO_AUTO_QR_LOGIN` | `true` | Start QR login automatically when not logged in |
| `ZALO_SEND_DELAY_MS` | `1500` | Pause between outgoing messages |
| `OUTBOX_POLL_MS` | `30000` | Fallback interval for checking the outbox |
| `ZALO_LOGGING` | `false` | Verbose zca-js logs |
| `ZALO_USER_AGENT` | Firefox UA | User agent used for login |

## API

The bridge has a small internal HTTP API (for PocketBase to call) and works through three PocketBase collections. Full reference in [`docs/`](docs/README.md):

- [HTTP API](docs/http-api.md): `GET /status`, `POST /kick`, `POST /login`, `POST /logout`, `POST /groups` (create a group), `POST /reactions` (react to a message). Every request needs the `x-bridge-secret` header.
- [Collections](docs/collections.md): `zalo_session`, `zalo_messages`, `zalo_outbox`, with their fields and required indexes.
- [Sending messages](docs/sending-messages.md): text, phone lookup, groups, files and replies.
- [Session and login](docs/session.md): statuses, QR login, reconnects.
- [PocketBase hooks](docs/pocketbase-hooks.md): send right away when an outbox record is created, and add login/logout routes.

Quick example: send a message from your app.

```js
await pb.collection("zalo_outbox").create({
  status: "pending",
  thread_id: "1234567890123456789",
  text: "Xin chào!",
});
```

## Building a standalone binary

```bash
bun run build                   # current platform -> dist/zalo-bridge
bun run build:linux-x64         # also: linux-x64-baseline, linux-arm64, linux-x64-musl, windows-x64
```

Run the binary with the same environment variables (e.g. from a `.env` file in the working directory, or a systemd `EnvironmentFile`).
