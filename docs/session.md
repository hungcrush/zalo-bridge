# Zalo session

The bridge keeps one Zalo login. Its state is in memory (returned by [`GET /status`](http-api.md#get-status)) and mirrored to the `zalo_session` record, so a UI can subscribe to that record for live updates.

Source: [`src/zalo.js`](../src/zalo.js)

## Statuses

| `status` | Meaning |
| --- | --- |
| `starting` | Bridge process just started (in memory only, before the first update) |
| `connecting` | Logging in with saved credentials |
| `qr_pending` | QR code ready in `qr_image`, waiting to be scanned |
| `qr_scanned` | QR scanned; waiting for confirmation on the phone. `account_name` is filled |
| `logged_in` | Listener connected — receiving and sending messages |
| `disconnected` | Connection closed; a reconnect is scheduled (see `message` for when) |
| `logged_out` | Not logged in: no saved credentials, credentials expired, QR expired/declined, or `/logout` called |
| `error` | QR login failed unexpectedly; see `message` |

## Startup

1. Wait until PocketBase is reachable and the superuser login works (retries every 5 s).
2. Mark any `zalo_outbox` records stuck in `sending` as `failed`.
3. Start the HTTP server.
4. Log in with `zalo_session.credentials` if present (`connecting` → `logged_in`).
5. If there are no credentials or they no longer work, credentials are cleared and, when `ZALO_AUTO_QR_LOGIN=true`, a QR login starts. Otherwise the status stays `logged_out` until `POST /login`.

## QR login

Started automatically (see above) or with [`POST /login`](http-api.md#post-login).

1. `qr_pending` — `qr_image` contains a PNG data URL. Show it as `<img src="{qr_image}">`.
2. Each QR lives about 100 seconds. When it expires the bridge generates a new one, up to **3 times**; after that the status becomes `logged_out` and a new `POST /login` is needed.
3. `qr_scanned` — the user scanned it; they must confirm on the phone.
4. On confirmation, `credentials` (cookie, imei, user agent) are saved and `qr_image` is cleared, so future restarts log in without a QR.
5. `logged_in` once the listener connects.

If the user declines on the phone, the status becomes `logged_out`.

## Disconnects and reconnects

- **Short network drops** are retried by zca-js itself; the status stays as is but sending pauses (`connected: false`).
- **Connection closed because Zalo Web is open elsewhere** (duplicate connection): status `disconnected`, retry after **5 minutes**. Zalo allows only one web session — close other Zalo Web tabs if this repeats.
- **Other closes**: status `disconnected`, retry with backoff — 15 s, 30 s, 60 s, … up to 5 minutes. The counter resets after a successful connection.
- Each retry logs in with the saved credentials; if they have expired, it falls back to QR login (when enabled).

When the listener reconnects, pending outbox messages are sent right away.

## Logout

[`POST /logout`](http-api.md#post-logout) stops the listener and deletes the saved credentials. To log in again, call `POST /login`.

On `SIGINT`/`SIGTERM` the bridge stops the listener but **keeps** the credentials, so the next start logs in automatically.
