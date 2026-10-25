# PocketBase hooks

Without hooks the bridge still works — it checks the outbox every `OUTBOX_POLL_MS` (default 30 s). Hooks make sending immediate and let your app trigger login/logout without exposing the bridge.

These examples use PocketBase's JS hooks (`pb_hooks/*.pb.js`, PocketBase v0.23+). Set the same secret on both sides:

```bash
# bridge .env
BRIDGE_SECRET=some-long-random-string

# PocketBase environment
ZALO_BRIDGE_SECRET=some-long-random-string
ZALO_BRIDGE_URL=http://127.0.0.1:3939
```

## Send immediately on new outbox records

`pb_hooks/zalo.pb.js`:

```js
onRecordAfterCreateSuccess((e) => {
  if (e.record.get("status") === "pending") {
    try {
      $http.send({
        url: ($os.getenv("ZALO_BRIDGE_URL") || "http://127.0.0.1:3939") + "/kick",
        method: "POST",
        headers: { "x-bridge-secret": $os.getenv("ZALO_BRIDGE_SECRET") },
        timeout: 5,
      });
    } catch (err) {
      // The bridge may be down; it will pick the record up when it starts.
      console.log("zalo-bridge /kick failed:", err);
    }
  }
  e.next();
}, "zalo_outbox");
```

To also send immediately when a `failed` record is set back to `pending`, register the same handler with `onRecordAfterUpdateSuccess`.

## Login / logout / status for your app

Expose the bridge through PocketBase routes protected by superuser auth, so the secret never reaches the browser.

PocketBase runs each hook handler in its own isolated context, so handlers can't see functions declared at the top of the file. Put the shared helper in a module and `require()` it inside each handler.

`pb_hooks/zalo_bridge.js` (not `.pb.js` — this is a module, not a hook file):

```js
module.exports = {
  call(method, path) {
    const res = $http.send({
      url: ($os.getenv("ZALO_BRIDGE_URL") || "http://127.0.0.1:3939") + path,
      method: method,
      headers: { "x-bridge-secret": $os.getenv("ZALO_BRIDGE_SECRET") },
      timeout: 10,
    });
    return { status: res.statusCode, body: res.json };
  },
};
```

`pb_hooks/zalo_routes.pb.js`:

```js
routerAdd("GET", "/api/zalo/status", (e) => {
  const r = require(`${__hooks}/zalo_bridge.js`).call("GET", "/status");
  return e.json(r.status, r.body);
}, $apis.requireSuperuserAuth());

routerAdd("POST", "/api/zalo/login", (e) => {
  const r = require(`${__hooks}/zalo_bridge.js`).call("POST", "/login");
  return e.json(r.status, r.body);
}, $apis.requireSuperuserAuth());

routerAdd("POST", "/api/zalo/logout", (e) => {
  const r = require(`${__hooks}/zalo_bridge.js`).call("POST", "/logout");
  return e.json(r.status, r.body);
}, $apis.requireSuperuserAuth());
```

Swap `$apis.requireSuperuserAuth()` for `$apis.requireAuth("users")` (plus your own checks) if regular users should manage the connection.

The UI can then call `POST /api/zalo/login` and subscribe to the `zalo_session` record to show the QR code and status live.
