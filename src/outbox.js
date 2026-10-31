import { ThreadType } from "zca-js";
import { imageSize } from "image-size";
import { config, log, logErr, sleep } from "./config.js";
import { looksLikeMarkdown, markdownToZalo } from "./markdown.js";
import { call } from "./pb.js";
import { getApi } from "./zalo.js";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

let running = false;
let again = false;

/** Báo có tin mới cần gửi. An toàn khi gọi nhiều lần liên tiếp. */
export function kickOutbox() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  (async () => {
    try {
      do {
        again = false;
        await drain();
      } while (again);
    } catch (e) {
      logErr("[outbox] Lỗi xử lý hàng đợi:", e?.message);
    } finally {
      running = false;
    }
  })();
}

async function drain() {
  while (getApi()) {
    const list = await call((pb) =>
      pb.collection("zalo_outbox").getList(1, 10, { filter: 'status = "pending"', sort: "created" }),
    );
    if (!list.items.length) return;
    for (const item of list.items) {
      if (!getApi()) return; // mất kết nối -> giữ nguyên "pending", gửi sau
      await sendOne(item);
      await sleep(config.sendDelayMs);
    }
  }
}

const update = (id, data) => call((pb) => pb.collection("zalo_outbox").update(id, data));

async function sendOne(item) {
  const api = getApi();
  await update(item.id, { status: "sending" });
  try {
    let threadId = item.thread_id;
    let type = item.thread_type === "group" ? ThreadType.Group : ThreadType.User;

    if (!threadId && item.phone) {
      const user = await api.findUser(item.phone.replace(/[^\d]/g, ""));
      threadId = user?.uid;
      type = ThreadType.User;
      if (!threadId) throw new Error("Không tìm thấy tài khoản Zalo của số điện thoại này");
    }
    if (!threadId) throw new Error("Thiếu thread_id hoặc phone");

    const text = item.text || "";
    // Có mentions thì gửi nguyên văn: chuyển markdown làm lệch pos/len của mentions
    const message =
      config.markdown && !item.mentions && looksLikeMarkdown(text) ? markdownToZalo(text) : { msg: text };

    if (item.reply_to) {
      const q = await call((pb) => pb.collection("zalo_messages").getOne(item.reply_to));
      const r = q.raw || {};
      message.quote = {
        content: r.content,
        msgType: r.msgType,
        propertyExt: r.propertyExt,
        uidFrom: r.uidFrom,
        msgId: r.msgId,
        cliMsgId: r.cliMsgId,
        ts: r.ts,
        ttl: r.ttl ?? 0,
      };
    }

    if (item.mentions) message.mentions = parseMentions(item.mentions, message.msg);

    const files = Array.isArray(item.attachments) ? item.attachments : item.attachments ? [item.attachments] : [];
    if (files.length) {
      message.attachments = await Promise.all(files.map((name) => downloadAttachment(item, name)));
    }

    if (!message.msg && !files.length) throw new Error("Tin nhắn trống");

    const res = await api.sendMessage(message, String(threadId), type);
    const msgId = res?.message?.msgId ?? res?.attachment?.[0]?.msgId ?? "";
    await update(item.id, {
      status: "sent",
      error: "",
      zalo_msg_id: String(msgId),
      resolved_thread_id: String(threadId),
      sent_at: new Date().toISOString(),
    });
    log(`[outbox] Đã gửi ${item.id} -> ${threadId}`);
  } catch (e) {
    logErr(`[outbox] Gửi ${item.id} thất bại:`, e?.message);
    await update(item.id, { status: "failed", error: String(e?.message ?? e).slice(0, 1000) }).catch(() => {});
  }
}

/** mentions: [{ uid, pos, len }] — pos/len tính theo ký tự trong text, uid "-1" = @Tất cả. Chỉ có tác dụng trong nhóm. */
function parseMentions(list, text) {
  if (!Array.isArray(list)) throw new Error("mentions phải là mảng");
  return list.map((m) => {
    const uid = String(m?.uid ?? "");
    const pos = Number(m?.pos);
    const len = Number(m?.len);
    if (!uid || !Number.isInteger(pos) || !Number.isInteger(len) || pos < 0 || len <= 0 || pos + len > text.length) {
      throw new Error("mention không hợp lệ: " + JSON.stringify(m));
    }
    return { uid, pos, len };
  });
}

async function downloadAttachment(record, filename) {
  const url = await call(async (pb) => {
    const token = await pb.files.getToken(); // file được đánh dấu protected
    return pb.files.getURL(record, filename, { token });
  });
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Không tải được file ${filename} (${resp.status})`);
  const data = Buffer.from(await resp.arrayBuffer());
  const metadata = { totalSize: data.length };
  if (IMAGE_EXT.test(filename)) {
    try {
      const { width, height } = imageSize(data);
      Object.assign(metadata, { width, height });
    } catch {}
  }
  return { data, filename, metadata };
}

/** Tin đang "sending" khi bridge bị tắt: không chắc đã gửi chưa -> đánh dấu failed để tránh gửi trùng. */
export async function failInterrupted() {
  const list = await call((pb) =>
    pb.collection("zalo_outbox").getFullList({ filter: 'status = "sending"' }),
  );
  for (const item of list) {
    await update(item.id, {
      status: "failed",
      error: "Bridge bị dừng khi đang gửi; tin có thể đã hoặc chưa được gửi. Kiểm tra rồi tạo lại nếu cần.",
    });
  }
  if (list.length) log(`[outbox] Đánh dấu ${list.length} tin bị gián đoạn là failed`);
}
