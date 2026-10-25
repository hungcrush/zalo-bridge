import { EventEmitter } from "node:events";
import {
  Zalo,
  ThreadType,
  LoginQRCallbackEventType as QR,
  CloseReason,
  ZaloApiLoginQRAborted,
} from "zca-js";
import { imageSize } from "image-size";
import { readFile } from "node:fs/promises";
import { config, log, logErr } from "./config.js";
import { call, getSession, safeUpdateSession } from "./pb.js";

export const events = new EventEmitter(); // "ready" khi listener kết nối xong

let api = null; // API của zca-js khi đã đăng nhập
let connected = false;
let generation = 0; // tăng mỗi lần kết nối/đăng xuất để bỏ qua sự kiện cũ
let qrLoginPromise = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let state = { status: "starting", message: "", accountId: "", accountName: "" };

const MAX_QR_RETRIES = 3; // mỗi mã QR sống ~100 giây

/** API sẵn sàng gửi tin hay chưa. */
export function getApi() {
  return connected ? api : null;
}
export function getState() {
  return { ...state, connected };
}

function setState(patch, persist = {}) {
  state = { ...state, ...patch };
  return safeUpdateSession({
    status: state.status,
    message: state.message,
    account_id: state.accountId,
    account_name: state.accountName,
    ...persist,
  });
}

// zca-js v2 cần hàm đọc kích thước ảnh khi gửi ảnh bằng đường dẫn file
async function imageMetadataGetter(filePath) {
  const data = await readFile(filePath);
  const { width, height } = imageSize(data);
  return { width, height, size: data.length };
}

function newZalo() {
  return new Zalo({
    selfListen: config.selfListen,
    logging: config.logging,
    checkUpdate: false,
    imageMetadataGetter,
  });
}

// ---------------------------------------------------------------------------
// Đăng nhập
// ---------------------------------------------------------------------------

/** Khởi động: dùng cookie đã lưu, nếu không được thì (tuỳ cấu hình) đăng nhập QR. */
export async function start() {
  const ok = await loginWithSaved();
  if (!ok && config.autoQR) startQRLogin();
}

async function loginWithSaved() {
  const session = await getSession();
  const creds = session?.credentials;
  if (!creds?.cookie || !creds?.imei || !creds?.userAgent) {
    await setState({ status: "logged_out", message: "Chưa đăng nhập Zalo" });
    return false;
  }
  try {
    await setState({ status: "connecting", message: "Đang đăng nhập bằng phiên đã lưu..." });
    const a = await newZalo().login(creds);
    await attach(a);
    return true;
  } catch (e) {
    logErr("[zalo] Đăng nhập bằng phiên đã lưu thất bại:", e?.message);
    await setState(
      { status: "logged_out", message: "Phiên đăng nhập đã hết hạn, cần quét QR lại: " + (e?.message ?? "") },
      { credentials: null },
    );
    return false;
  }
}

/** Bắt đầu đăng nhập bằng QR. Mã QR được ghi vào zalo_session.qr_image. */
export function startQRLogin() {
  if (qrLoginPromise) return qrLoginPromise;
  if (connected) return Promise.resolve();
  clearTimeout(reconnectTimer);

  qrLoginPromise = (async () => {
    let expired = 0;
    let aborted = false;
    try {
      const a = await newZalo().loginQR({ userAgent: config.userAgent }, async (ev) => {
        switch (ev.type) {
          case QR.QRCodeGenerated:
            log("[zalo] Đã tạo mã QR, chờ quét...");
            await setState(
              { status: "qr_pending", message: "Mở ứng dụng Zalo trên điện thoại và quét mã QR" },
              { qr_image: "data:image/png;base64," + ev.data.image },
            );
            break;
          case QR.QRCodeExpired:
            if (++expired <= MAX_QR_RETRIES) {
              log(`[zalo] Mã QR hết hạn, tạo mã mới (${expired}/${MAX_QR_RETRIES})`);
              ev.actions.retry();
            } else {
              aborted = true;
              ev.actions.abort();
              await setState(
                { status: "logged_out", message: "Mã QR đã hết hạn. Bấm đăng nhập để tạo mã mới." },
                { qr_image: "" },
              );
            }
            break;
          case QR.QRCodeScanned:
            await setState({
              status: "qr_scanned",
              accountName: ev.data?.display_name ?? "",
              message: "Đã quét. Hãy xác nhận đăng nhập trên điện thoại.",
            });
            break;
          case QR.QRCodeDeclined:
            aborted = true;
            ev.actions.abort();
            await setState({ status: "logged_out", message: "Đăng nhập bị từ chối trên điện thoại" }, { qr_image: "" });
            break;
          case QR.GotLoginInfo:
            // Lưu cookie/imei/userAgent để lần sau không cần quét QR
            await safeUpdateSession({ credentials: ev.data, qr_image: "" });
            break;
        }
      });
      await attach(a);
    } catch (e) {
      if (aborted || e instanceof ZaloApiLoginQRAborted) return;
      logErr("[zalo] Đăng nhập QR thất bại:", e?.message);
      await setState({ status: "error", message: "Đăng nhập QR thất bại: " + (e?.message ?? "") }, { qr_image: "" });
    } finally {
      qrLoginPromise = null;
    }
  })();
  return qrLoginPromise;
}

/** "Đăng xuất" phía bridge: ngắt listener và xoá cookie đã lưu. */
export async function logout() {
  generation++;
  clearTimeout(reconnectTimer);
  try {
    api?.listener.stop();
  } catch {}
  api = null;
  connected = false;
  await setState(
    { status: "logged_out", message: "Đã đăng xuất khỏi bridge", accountId: "", accountName: "" },
    { credentials: null, qr_image: "" },
  );
}

export function stop() {
  generation++;
  clearTimeout(reconnectTimer);
  try {
    api?.listener.stop();
  } catch {}
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

async function attach(a) {
  const myGen = ++generation;
  try {
    api?.listener.stop();
  } catch {}
  api = a;
  connected = false;

  const accountId = a.getOwnId();
  let accountName = state.accountName;
  try {
    const info = await a.fetchAccountInfo();
    accountName = info?.profile?.displayName || info?.profile?.zaloName || accountName;
  } catch {}
  state = { ...state, accountId, accountName };

  const l = a.listener;
  l.on("connected", async () => {
    if (myGen !== generation) return;
    connected = true;
    reconnectAttempt = 0;
    log(`[zalo] Listener đã kết nối (tài khoản ${accountName || accountId})`);
    await setState({ status: "logged_in", message: "Đang hoạt động" }, { qr_image: "" });
    events.emit("ready");
  });
  l.on("disconnected", (code, reason) => {
    if (myGen !== generation) return;
    connected = false;
    log(`[zalo] Mất kết nối tạm thời (${code} ${reason ?? ""}), zca-js đang thử lại...`);
  });
  l.on("closed", (code, reason) => {
    if (myGen !== generation) return;
    connected = false;
    handleClosed(code, reason);
  });
  l.on("error", (e) => logErr("[zalo] Lỗi listener:", e?.message ?? e));
  l.on("message", (m) => saveMessage(m).catch((e) => logErr("[zalo] Lỗi lưu tin:", e?.message, e?.response ?? "")));
  l.on("undo", (u) => markRecalled(u).catch((e) => logErr("[zalo] Lỗi xử lý thu hồi:", e?.message)));

  l.start({ retryOnClose: true });
}

function handleClosed(code, reason) {
  let delay;
  let message;
  if (code === CloseReason.DuplicateConnection) {
    // Có nơi khác (Zalo Web/trình duyệt) đang dùng tài khoản này
    delay = 5 * 60_000;
    message = "Tài khoản đang được mở Zalo Web ở nơi khác. Sẽ thử kết nối lại sau 5 phút.";
  } else if (code === CloseReason.ManualClosure) {
    return;
  } else {
    delay = Math.min(5 * 60_000, 15_000 * 2 ** reconnectAttempt);
    message = `Mất kết nối (${code} ${reason ?? ""}). Thử lại sau ${Math.round(delay / 1000)}s.`;
  }
  reconnectAttempt++;
  log("[zalo]", message);
  setState({ status: "disconnected", message });
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    const ok = await loginWithSaved();
    if (!ok && config.autoQR) startQRLogin();
  }, delay);
}

// ---------------------------------------------------------------------------
// Lưu tin nhắn vào PocketBase
// ---------------------------------------------------------------------------

function extractText(content) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    // ảnh/file/link thường có title hoặc description
    return String(content.title || content.description || "");
  }
  return "";
}

async function saveMessage(m) {
  const d = m.data;
  const record = {
    msg_id: String(d.msgId),
    cli_msg_id: String(d.cliMsgId ?? ""),
    thread_id: String(m.threadId),
    thread_type: m.type === ThreadType.Group ? "group" : "user",
    sender_id: String(d.uidFrom ?? ""),
    sender_name: d.dName ?? "",
    msg_type: d.msgType ?? "",
    text: extractText(d.content),
    content: typeof d.content === "string" ? null : d.content,
    is_self: !!m.isSelf,
    zalo_ts: Number(d.ts) || 0,
    quote: d.quote ?? null,
    raw: d,
  };
  try {
    await call((pb) => pb.collection("zalo_messages").create(record));
  } catch (e) {
    // Trùng msg_id (unique index) -> đã lưu rồi, bỏ qua
    if (e?.status === 400 && e?.response?.data?.msg_id) return;
    throw e;
  }
}

async function markRecalled(u) {
  const id = String(u.data?.content?.globalMsgId ?? "");
  if (!id) return;
  try {
    const rec = await call((pb) =>
      pb.collection("zalo_messages").getFirstListItem(pb.filter("msg_id = {:id}", { id })),
    );
    await call((pb) => pb.collection("zalo_messages").update(rec.id, { recalled: true }));
  } catch (e) {
    if (e?.status !== 404) throw e;
  }
}
