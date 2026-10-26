const env = (key, def) => {
  const v = process.env[key];
  return v === undefined || v === "" ? def : v;
};
const bool = (key, def) => String(env(key, def)).toLowerCase() === "true";

export const config = {
  pbUrl: env("PB_URL", "http://127.0.0.1:8090"),
  pbEmail: env("PB_SUPERUSER_EMAIL"),
  pbPassword: env("PB_SUPERUSER_PASSWORD"),

  host: env("BRIDGE_HOST", "127.0.0.1"),
  port: Number(env("BRIDGE_PORT", "3939")),
  secret: env("BRIDGE_SECRET"),

  selfListen: bool("ZALO_SELF_LISTEN", "true"),
  autoQR: bool("ZALO_AUTO_QR_LOGIN", "true"),
  sendDelayMs: Number(env("ZALO_SEND_DELAY_MS", "1500")),
  pollMs: Number(env("OUTBOX_POLL_MS", "30000")),
  markdown: bool("ZALO_MARKDOWN", "true"),
  logging: bool("ZALO_LOGGING", "false"),
  userAgent: env(
    "ZALO_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  ),
};

export function validateConfig() {
  const missing = [];
  if (!config.pbEmail) missing.push("PB_SUPERUSER_EMAIL");
  if (!config.pbPassword) missing.push("PB_SUPERUSER_PASSWORD");
  if (!config.secret || config.secret.length < 16) missing.push("BRIDGE_SECRET (>= 16 ký tự)");
  if (missing.length) {
    console.error("[config] Thiếu biến môi trường:", missing.join(", "));
    process.exit(1);
  }
}

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const logErr = (...a) => console.error(new Date().toISOString(), ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
