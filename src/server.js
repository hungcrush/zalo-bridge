import { timingSafeEqual } from "node:crypto";
import { config, log } from "./config.js";
import { getState, startQRLogin, logout } from "./zalo.js";
import { kickOutbox } from "./outbox.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function authorized(req) {
  const given = Buffer.from(req.headers.get("x-bridge-secret") ?? "");
  const expected = Buffer.from(config.secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
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
        }
      }
      return json({ error: "not found" }, 404);
    },
  });
  log(`[http] Bridge lắng nghe tại http://${server.hostname}:${server.port}`);
  return server;
}
