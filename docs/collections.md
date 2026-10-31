# PocketBase collections

The bridge uses three collections. It authenticates as a superuser, so API rules do not affect the bridge — set them for your own app users. The collections are not created automatically; create them in the PocketBase dashboard (or a migration) with the fields below.

Field types are inferred from how the bridge reads/writes them; adjust if your schema differs (e.g. `select` vs `text`), as long as the stored values match.

---

## `zalo_session`

Holds a single record with the fixed id **`zalomainsession`** (15 characters, as PocketBase requires). The bridge creates it if missing.

| Field | Type | Written by bridge | Notes |
| --- | --- | --- | --- |
| `status` | text | ✓ | See [session statuses](session.md#statuses) |
| `message` | text | ✓ | Human-readable status (Vietnamese) |
| `account_id` | text | ✓ | Zalo id of the account |
| `account_name` | text | ✓ | Display name |
| `qr_image` | text | ✓ | `data:image/png;base64,...` while a QR is waiting to be scanned, otherwise empty. Needs a large max length (or 0 = no limit) |
| `credentials` | json | ✓ | `{ cookie, imei, userAgent }` from zca-js; `null` when logged out |

> 🔒 `credentials` gives full access to the Zalo account. Do not expose this collection to non-admin users; if your UI needs the status/QR, add a view collection or hide the field.

---

## `zalo_messages`

One record per Zalo message received (and, with `ZALO_SELF_LISTEN=true`, sent by the account). Written by the bridge; your app reads it.

| Field | Type | Notes |
| --- | --- | --- |
| `msg_id` | text | Zalo global message id. **Add a unique index** — the bridge relies on it to skip duplicates |
| `cli_msg_id` | text | Client message id |
| `thread_id` | text | User id (1:1 chat) or group id |
| `thread_type` | select (`user`, `group`) | |
| `sender_id` | text | Zalo id of the sender |
| `sender_name` | text | Sender display name |
| `msg_type` | text | zca-js message type, e.g. `webchat`, `chat.photo`, `chat.sticker` |
| `text` | text | Plain text; for attachments/links, the `title` or `description` if any |
| `content` | json | Original structured content for non-text messages, `null` for plain text |
| `is_self` | bool | `true` if sent by the bridge's account |
| `zalo_ts` | number | Zalo timestamp (ms) |
| `quote` | json | The quoted message, if this is a reply |
| `raw` | json | Full raw payload from zca-js. Used to build quotes when replying |
| `recalled` | bool | Set to `true` when the sender recalls (undoes) the message |

Suggested index for listing a conversation: `(thread_id, zalo_ts)`.

---

## `zalo_outbox`

Messages to send. Your app creates records; the bridge sends them and updates the status.

### Fields you set

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | select (`pending`, `sending`, `sent`, `failed`) | ✓ | Create with `pending` |
| `thread_id` | text | one of `thread_id` / `phone` | Recipient user id or group id |
| `thread_type` | select (`user`, `group`) | | Defaults to `user` when not `group`. Ignored when sending by `phone` |
| `phone` | text | one of `thread_id` / `phone` | Phone number; non-digits are stripped, then looked up with Zalo's user search. Used only when `thread_id` is empty |
| `text` | text | `text` and/or `attachments` | Message body |
| `attachments` | file (multiple, **protected**) | | Files to send. Images (`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`) are sent with their dimensions |
| `reply_to` | relation → `zalo_messages` (single) | | Message to quote. Its `raw` field must be present |
| `mentions` | json | | Array of `{ uid, pos, len }` tagging users in `text`. Groups only. See [mentions](sending-messages.md#mentioning-people-in-a-group) |

### Fields the bridge sets

| Field | Type | Notes |
| --- | --- | --- |
| `error` | text | Failure reason (max 1000 chars); cleared on success |
| `zalo_msg_id` | text | Message id returned by Zalo |
| `resolved_thread_id` | text | Thread id actually used (useful when sending by `phone`) |
| `sent_at` | date | Time sent |
| `created` | autodate | Needed — the outbox is processed in `created` order |

### Status lifecycle

```
pending ──► sending ──► sent
                   └──► failed
```

- The bridge picks up `pending` records 10 at a time, oldest first, waiting `ZALO_SEND_DELAY_MS` between sends.
- If Zalo disconnects, remaining records stay `pending` and are sent after reconnecting.
- Records still `sending` when the bridge starts (it was stopped mid-send) are set to `failed`, because it is unknown whether Zalo delivered them. Check and re-create them if needed — the bridge never retries automatically.
- To retry a `failed` record, set its `status` back to `pending`.

See [sending-messages.md](sending-messages.md) for examples.
