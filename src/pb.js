import PocketBase from "pocketbase";
import { config, log } from "./config.js";

export const pb = new PocketBase(config.pbUrl);
// Bridge gửi nhiều request song song, không để SDK tự huỷ request trùng
pb.autoCancellation(false);

export const SESSION_ID = "zalomainsession"; // id cố định 15 ký tự

async function authenticate() {
  await pb.collection("_superusers").authWithPassword(config.pbEmail, config.pbPassword);
}

/** Gọi PocketBase, tự đăng nhập lại nếu token hết hạn. */
export async function call(fn) {
  if (!pb.authStore.isValid) await authenticate();
  try {
    return await fn(pb);
  } catch (e) {
    if (e?.status === 401 || e?.status === 403) {
      await authenticate();
      return await fn(pb);
    }
    throw e;
  }
}

/** Chờ đến khi PocketBase sẵn sàng và đăng nhập được. */
export async function waitForPocketBase() {
  for (let i = 1; ; i++) {
    try {
      await authenticate();
      log(`[pb] Đã kết nối PocketBase tại ${config.pbUrl}`);
      return;
    } catch (e) {
      log(`[pb] Chưa kết nối được PocketBase (lần ${i}): ${e?.message}. Thử lại sau 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export async function getSession() {
  try {
    return await call((pb) => pb.collection("zalo_session").getOne(SESSION_ID));
  } catch (e) {
    if (e?.status === 404) return null;
    throw e;
  }
}

/** Cập nhật (hoặc tạo) bản ghi trạng thái phiên Zalo duy nhất. */
export async function updateSession(data) {
  try {
    return await call((pb) => pb.collection("zalo_session").update(SESSION_ID, data));
  } catch (e) {
    if (e?.status !== 404) throw e;
    return await call((pb) => pb.collection("zalo_session").create({ id: SESSION_ID, ...data }));
  }
}

/** Như updateSession nhưng không ném lỗi (dùng trong callback). */
export async function safeUpdateSession(data) {
  try {
    await updateSession(data);
  } catch (e) {
    console.error("[pb] Không cập nhật được zalo_session:", e?.message, e?.response ?? "");
  }
}
