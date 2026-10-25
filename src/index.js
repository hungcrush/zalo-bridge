import { config, validateConfig, log } from "./config.js";
import { waitForPocketBase } from "./pb.js";
import { start, stop, events } from "./zalo.js";
import { kickOutbox, failInterrupted } from "./outbox.js";
import { startServer } from "./server.js";

validateConfig();
log("[bridge] Khởi động zalo-bridge");

await waitForPocketBase();
await failInterrupted();

const server = startServer();

events.on("ready", kickOutbox); // vừa kết nối xong -> gửi các tin đang chờ
setInterval(kickOutbox, config.pollMs); // dự phòng nếu PocketBase không gọi được /kick

await start();

const shutdown = () => {
  log("[bridge] Đang dừng...");
  stop();
  server.stop();
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
