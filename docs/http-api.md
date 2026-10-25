# HTTP API

The bridge runs a small HTTP server (Bun) at `http://BRIDGE_HOST:BRIDGE_PORT` (default `http://127.0.0.1:3939`). It is meant to be called by PocketBase on the same machine — keep it bound to `127.0.0.1` or a private network.

Source: [`src/server.js`](../src/server.js)

## Authentication

Every request must include the shared secret:

```
x-bridge-secret: <BRIDGE_SECRET>
```

The secret is compared in constant time. Authentication is checked **before** routing, so a request without a valid secret gets `401` even for an unknown path.

```json
// 401 Unauthorized
{ "error": "unauthorized" }
```

Unknown method/path combinations (with a valid secret) return:

```json
// 404 Not Found
{ "error": "not found" }
```

All responses are `application/json`.

---

## `GET /status`

Returns the bridge's current Zalo state (held in memory; the same values are mirrored to the `zalo_session` record).

**Response `200`**

```json
{
  "status": "logged_in",
  "message": "Đang hoạt động",
  "accountId": "1234567890123456789",
  "accountName": "Nguyễn Văn A",
  "connected": true
}
```

| Field | Type | Description |
| --- | --- | --- |
| `status` | string | See [session statuses](session.md#statuses) |
| `message` | string | Human-readable status message (Vietnamese) |
| `accountId` | string | Zalo id of the logged-in account, empty when logged out |
| `accountName` | string | Display name, empty when unknown |
| `connected` | boolean | `true` only while the realtime listener is connected — messages can be sent only then |

```bash
curl -s -H "x-bridge-secret: $BRIDGE_SECRET" http://127.0.0.1:3939/status
```

---

## `POST /kick`

Asks the bridge to process `zalo_outbox` records with `status = "pending"` now, instead of waiting for the next poll (`OUTBOX_POLL_MS`). Returns immediately; sending happens in the background.

Safe to call repeatedly: if the outbox is already being processed, the bridge runs one more pass after the current one finishes. If Zalo is not connected, nothing is sent and records stay `pending` until the connection comes back.

**Response `202`**

```json
{ "ok": true }
```

```bash
curl -s -X POST -H "x-bridge-secret: $BRIDGE_SECRET" http://127.0.0.1:3939/kick
```

---

## `POST /login`

Starts a QR-code login. Does not wait for the scan: the QR image is written to `zalo_session.qr_image` and progress is reported through `zalo_session.status`. See [session.md](session.md#qr-login).

If a QR login is already running, the existing one is reused.

**Response `200`** — already connected, nothing to do:

```json
{
  "ok": true,
  "status": "logged_in",
  "message": "Đang hoạt động",
  "accountId": "1234567890123456789",
  "accountName": "Nguyễn Văn A",
  "connected": true
}
```

**Response `202`** — QR login started:

```json
{ "ok": true, "message": "Đang tạo mã QR" }
```

```bash
curl -s -X POST -H "x-bridge-secret: $BRIDGE_SECRET" http://127.0.0.1:3939/login
```

---

## `POST /logout`

Logs the bridge out: stops the listener, cancels any pending reconnect, and clears `credentials` and `qr_image` in `zalo_session`. The status becomes `logged_out`.

This only removes the bridge's session; it does not log the account out on the phone. A new `POST /login` is required afterwards (auto QR login does not restart until the bridge is restarted).

**Response `200`**

```json
{ "ok": true }
```

```bash
curl -s -X POST -H "x-bridge-secret: $BRIDGE_SECRET" http://127.0.0.1:3939/logout
```

---

## `POST /groups`

Creates a new Zalo group owned by the bridge's account. Unlike sending messages, this runs synchronously and returns the new group id.

**Request body** (`application/json`)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | | Group name. If omitted, Zalo uses a default (timestamp) name |
| `members` | string[] | one of `members` / `phones` | Zalo user ids to add |
| `phones` | string[] | one of `members` / `phones` | Phone numbers; non-digits are stripped and each is looked up on Zalo |

Ids from `members` and resolved `phones` are merged and de-duplicated. At least one valid member is required besides the account itself.

```json
{
  "name": "Lớp Toán 10A",
  "members": ["1234567890123456789"],
  "phones": ["0901 234 567", "0912345678"]
}
```

**Response `201`**

```json
{
  "ok": true,
  "groupId": "9876543210987654321",
  "successMembers": ["1234567890123456789", "2345678901234567890"],
  "errorMembers": [],
  "phonesNotFound": ["0912345678"]
}
```

| Field | Description |
| --- | --- |
| `groupId` | New group id — use it as `thread_id` with `thread_type: "group"` in `zalo_outbox` |
| `successMembers` | User ids added to the group |
| `errorMembers` | User ids Zalo refused to add (e.g. privacy settings block group invites) |
| `phonesNotFound` | Entries from `phones` with no Zalo account |

**Errors**

| Status | When |
| --- | --- |
| `400` | Body is not valid JSON, fields have the wrong type, or both `members` and `phones` are empty |
| `502` | Zalo rejected the request, or none of the phones resolved to an account. `error` holds the reason |
| `503` | Zalo is not connected (`{ "error": "Zalo chưa kết nối" }`) |

```bash
curl -s -X POST http://127.0.0.1:3939/groups \
  -H "x-bridge-secret: $BRIDGE_SECRET" \
  -H "content-type: application/json" \
  -d '{"name":"Lớp Toán 10A","phones":["0901234567"]}'
```

> Creating many groups quickly can get the account restricted by Zalo. The group appears in `zalo_messages` only once someone sends a message in it.

---

## `POST /reactions`

Adds a reaction (emoji) to a message, or removes the account's reaction. The message must already be in `zalo_messages`: the bridge reads its `msg_id`, `cli_msg_id`, `thread_id` and `thread_type` from there.

**Request body** (`application/json`)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `message_id` | string | one of `message_id` / `msg_id` | PocketBase record id in `zalo_messages` |
| `msg_id` | string | one of `message_id` / `msg_id` | Zalo message id (`zalo_messages.msg_id`). Ignored if `message_id` is given |
| `reaction` | string | ✓ | Reaction name (case-insensitive), see below. `NONE` removes the reaction |

```json
{ "message_id": "k2x9q8w7e6r5t4y", "reaction": "HEART" }
```

**Response `200`**

```json
{
  "ok": true,
  "messageId": "k2x9q8w7e6r5t4y",
  "msgId": "7012345678901",
  "reaction": "HEART",
  "msgIds": [7012345678950]
}
```

**Errors**

| Status | When |
| --- | --- |
| `400` | Invalid JSON, no message given, or unknown `reaction` (the response includes an `allowed` list) |
| `404` | The message is not in `zalo_messages` |
| `422` | The stored message has no `cli_msg_id`, so Zalo can't target it |
| `502` | Zalo rejected the request; `error` holds the reason |
| `503` | Zalo is not connected |

```bash
curl -s -X POST http://127.0.0.1:3939/reactions \
  -H "x-bridge-secret: $BRIDGE_SECRET" \
  -H "content-type: application/json" \
  -d '{"msg_id":"7012345678901","reaction":"like"}'
```

**Reaction names** (from zca-js `Reactions`):

| Common | Name |
| --- | --- |
| ❤️ | `HEART` |
| 👍 | `LIKE` |
| 😆 | `HAHA` |
| 😮 | `WOW` |
| 😭 | `CRY` |
| 😡 | `ANGRY` |
| — | `NONE` (remove reaction) |

All others: `KISS`, `TEARS_OF_JOY`, `SHIT`, `ROSE`, `BROKEN_HEART`, `DISLIKE`, `LOVE`, `CONFUSED`, `WINK`, `FADE`, `SUN`, `BIRTHDAY`, `BOMB`, `OK`, `PEACE`, `THANKS`, `PUNCH`, `SHARE`, `PRAY`, `NO`, `BAD`, `LOVE_YOU`, `SAD`, `VERY_SAD`, `COOL`, `NERD`, `BIG_SMILE`, `SUNGLASSES`, `NEUTRAL`, `SAD_FACE`, `BYE`, `SLEEPY`, `WIPE`, `DIG`, `ANGUISH`, `HANDCLAP`, `ANGRY_FACE`, `F_CHAIR`, `L_CHAIR`, `R_CHAIR`, `SILENT`, `SURPRISE`, `EMBARRASSED`, `AFRAID`, `SAD2`, `BIG_LAUGH`, `RICH`, `BEER`.

> To react to messages the bridge itself sent, keep `ZALO_SELF_LISTEN=true` so they are stored in `zalo_messages`. Incoming reactions from other people are not saved yet.
