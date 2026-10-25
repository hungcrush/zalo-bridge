import { timingSafeEqual } from "node:crypto";
import { config, log } from "./config.js";
import { getState, startQRLogin, logout, createGroup, addReaction, REACTION_NAMES } from "./zalo.js";
import { kickOutbox } from "./outbox.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function authorized(req) {
  const given = Buffer.from(req.headers.get("x-bridge-secret") ?? "");
  const expected = Buffer.from(config.secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const isStrList = (v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string" && x));

async function handleCreateGroup(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const { name, members, phones } = body ?? {};
  if ((name !== undefined && typeof name !== "string") || !isStrList(members) || !isStrList(phones)) {
    return json({ error: "name phải là chuỗi; members, phones phải là mảng chuỗi" }, 400);
  }
  if (!members?.length && !phones?.length) {
    return json({ error: "Cần ít nhất một thành viên (members hoặc phones)" }, 400);
  }
  if (!getState().connected) return json({ error: "Zalo chưa kết nối" }, 503);

  try {
    return json({ ok: true, ...(await createGroup({ name, members, phones })) }, 201);
  } catch (e) {
    log("[http] Tạo nhóm thất bại:", e?.message);
    return json({ error: String(e?.message ?? e) }, 502);
  }
}

async function handleAddReaction(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const { message_id, msg_id, reaction } = body ?? {};
  if (!(typeof message_id === "string" && message_id) && !(typeof msg_id === "string" && msg_id)) {
    return json({ error: "Cần message_id (id bản ghi zalo_messages) hoặc msg_id" }, 400);
  }
  if (typeof reaction !== "string" || !REACTION_NAMES.includes(reaction.toUpperCase())) {
    return json({ error: "reaction không hợp lệ", allowed: REACTION_NAMES }, 400);
  }

  try {
    return json({ ok: true, ...(await addReaction({ id: message_id, msgId: msg_id, reaction })) });
  } catch (e) {
    if (e?.httpStatus) return json({ error: e.message }, e.httpStatus);
    log("[http] Thả reaction thất bại:", e?.message);
    return json({ error: String(e?.message ?? e) }, 502);
  }
}

export function startServer() {
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (!authorized(req)) return json({ error: "unauthorized" }, 401);

      if (req.method === "GET" && pathname === "/status") return json(getState());

      if (req.method === "POST") {
        switch (pathname) {
          case "/kick":
            kickOutbox();
            return json({ ok: true }, 202);
          case "/login":
            if (getState().connected) return json({ ok: true, ...getState() });
            startQRLogin(); // không chờ: QR sẽ xuất hiện trong zalo_session
            return json({ ok: true, message: "Đang tạo mã QR" }, 202);
          case "/logout":
            await logout();
            return json({ ok: true });
          case "/groups":
            return handleCreateGroup(req);
          case "/reactions":
            return handleAddReaction(req);
        }
      }
      return json({ error: "not found" }, 404);
    },
  });
  log(`[http] Bridge lắng nghe tại http://${server.hostname}:${server.port}`);
  return server;
}
