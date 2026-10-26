# Sending messages

To send a Zalo message, create a `zalo_outbox` record with `status: "pending"`. The bridge sends it on the next `/kick` (see [pocketbase-hooks.md](pocketbase-hooks.md)) or within `OUTBOX_POLL_MS` (default 30 s), then updates the record. Field reference: [collections.md](collections.md#zalo_outbox).

Examples use the PocketBase JS SDK; the same works with the REST API (`POST /api/collections/zalo_outbox/records`).

## Text to a user

```js
await pb.collection("zalo_outbox").create({
  status: "pending",
  thread_id: "1234567890123456789",
  thread_type: "user",
  text: "Xin chào!",
});
```

## Text to a phone number

Used when you don't know the Zalo id. The bridge looks the number up; if no Zalo account is found the record becomes `failed`.

```js
await pb.collection("zalo_outbox").create({
  status: "pending",
  phone: "0901 234 567",
  text: "Xin chào!",
});
```

After sending, `resolved_thread_id` holds the user's id — store it and use `thread_id` next time to skip the lookup.

## Message to a group

```js
await pb.collection("zalo_outbox").create({
  status: "pending",
  thread_id: "9876543210987654321",
  thread_type: "group",
  text: "Thông báo cho cả nhóm",
});
```

## Markdown formatting

If `text` looks like Markdown, the bridge converts it to Zalo's own formatting before sending. Plain text is sent unchanged. Set `ZALO_MARKDOWN=false` to turn this off.

| Markdown | In Zalo |
| --- | --- |
| `**bold**`, `__bold__` | **bold** |
| `*italic*`, `_italic_` | _italic_ |
| `***both***` | bold + italic |
| `~~strike~~` | strikethrough |
| `# Heading`, `## Heading` | bold, large text |
| `### Heading` and deeper | bold |
| `- item`, `* item`, `+ item` | `• item` (indentation kept) |
| `1. item` | `1. item` |
| `- [ ] task`, `- [x] task` | `☐ task`, `☑ task` |
| `> quote` | `▎ quote` in italic |
| `[label](url)` | `label (url)` |
| `` `code` ``, code blocks | text kept as-is, without the backticks or fences |
| `---` | a divider line |
| `\*` (escapes) | the literal character |

Underscores inside words (`snake_case`) are not treated as italics, and runs of blank lines are collapsed to one.

```js
await pb.collection("zalo_outbox").create({
  status: "pending",
  thread_id: "1234567890123456789",
  text: "## Đơn hàng #1024\n- Trạng thái: **đã giao**\n- Ghi chú: _giao giờ hành chính_",
});
```

## Files and images

`attachments` is a multi-file field. `text`, if given, is sent with the files.

```js
const form = new FormData();
form.append("status", "pending");
form.append("thread_id", "1234567890123456789");
form.append("text", "Hoá đơn tháng 10");
form.append("attachments", new File([pdfBytes], "invoice.pdf"));
form.append("attachments", new File([pngBytes], "photo.png"));
await pb.collection("zalo_outbox").create(form);
```

## Replying to a message

Set `reply_to` to the id of a `zalo_messages` record. The message is sent with that message quoted. Use the same `thread_id` as the original.

```js
const original = await pb.collection("zalo_messages").getOne(messageId);
await pb.collection("zalo_outbox").create({
  status: "pending",
  thread_id: original.thread_id,
  thread_type: original.thread_type,
  reply_to: original.id,
  text: "Đã nhận, cảm ơn bạn!",
});
```

## Checking the result

Subscribe to the record (or poll it) and watch `status`:

```js
pb.collection("zalo_outbox").subscribe(record.id, ({ record }) => {
  if (record.status === "sent") console.log("Sent", record.zalo_msg_id);
  if (record.status === "failed") console.error(record.error);
});
```

Common `error` values:

| Error | Cause |
| --- | --- |
| `Thiếu thread_id hoặc phone` | Neither recipient field was set |
| `Không tìm thấy tài khoản Zalo của số điện thoại này` | Phone lookup found no Zalo account |
| `Tin nhắn trống` | No `text` and no `attachments` |
| `Không tải được file ... (status)` | The bridge could not download an attachment from PocketBase |
| `Bridge bị dừng khi đang gửi; ...` | The bridge stopped mid-send; the message may or may not have been delivered |
| anything else | Error from Zalo/zca-js |

## Limits

- Messages are sent one by one with `ZALO_SEND_DELAY_MS` (default 1500 ms) between them. Lowering it increases the risk of Zalo restricting the account.
- Nothing is sent while `zalo_session.status` is not `logged_in`; records wait as `pending`.
