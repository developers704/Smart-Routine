/**
 * Regression: refreshTickGate() treated a local PushManager subscription as
 * proof the server had registered it. If POST /api/push/subscribe had failed, or
 * the server lost its subscription file, in-page delivery was switched off and
 * the device received nothing at all.
 *
 * The gate must now depend on server-confirmed registration.
 */
let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

// --- fake browser ---------------------------------------------------------
const server = {
  registered: new Set(),
  vapid: "BK0t-3GfT4ripvC7EwglS-RGg39YJ693tPb8BBkd_F8x34QpIVwfmJvFBZG5zxUWrPsYUWaRSPefg_kQ40H7kO0",
  acceptSubscribe: true,
  verifyCalls: 0,
  subscribeCalls: 0,
};

const pushManager = {
  subscription: null,
  subscribeShouldFail: false,
  async getSubscription() {
    return this.subscription;
  },
  async subscribe() {
    if (this.subscribeShouldFail) throw new Error("subscribe denied");
    this.subscription = {
      endpoint: "https://push.example/device-a",
      toJSON() {
        return { endpoint: this.endpoint };
      },
    };
    return this.subscription;
  },
};

globalThis.window = {
  matchMedia: () => ({ matches: true }),
  PushManager: function PushManager() {},
  navigator: {},
};
Object.defineProperty(globalThis, "navigator", {
  value: {
    userAgent: "iPhone; CPU iPhone OS 26_0 like Mac OS X",
    standalone: true,
    serviceWorker: { ready: Promise.resolve({ pushManager }) },
  },
  configurable: true,
  writable: true,
});
globalThis.Notification = { permission: "granted" };
globalThis.Capacitor = undefined;

globalThis.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : {};
  const json = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  });
  if (url === "/api/push/vapid-public-key") return json({ publicKey: server.vapid });
  if (url === "/api/push/subscribe") {
    server.subscribeCalls++;
    if (!server.acceptSubscribe) return json({ ok: false, error: "vapid-not-configured" }, 503);
    server.registered.add(body.endpoint);
    return json({ ok: true, devices: server.registered.size });
  }
  if (url === "/api/push/verify") {
    server.verifyCalls++;
    return json({ ok: true, registered: server.registered.has(body.endpoint) });
  }
  if (url === "/api/push/status") return json({ configured: true, devices: server.registered.size });
  return json({}, 404);
};

const { refreshTickGate } = await import("../client/routine-alarms.js");
const { inPageTickingEnabled } = await import("../client/alarms.js");
const { setupWebPush } = await import("../client/push.js");

function resetServer() {
  server.registered.clear();
  server.acceptSubscribe = true;
  server.verifyCalls = 0;
  server.subscribeCalls = 0;
}

// --- 1. local subscription + successful server registration -------------
resetServer();
pushManager.subscription = { endpoint: "https://push.example/device-a", toJSON: () => ({ endpoint: "https://push.example/device-a" }) };
server.registered.add("https://push.example/device-a");
let gate = await refreshTickGate();
assert(gate.pushSubscribed === true, "A server-confirmed subscription counts as subscribed");
assert(gate.tick === false, "In-page ticking is off when the server will deliver");
assert(inPageTickingEnabled() === false, "The ticking switch follows the gate");
assert(server.verifyCalls === 1, "The gate verifies registration with the server");

// --- 2. local subscription + server registration failed -----------------
resetServer();
server.acceptSubscribe = false;
gate = await refreshTickGate();
assert(gate.pushSubscribed === false, "An unregistered endpoint does not count as subscribed");
assert(gate.tick === true, "In-page ticking stays on so the device is not left silent");
assert(inPageTickingEnabled() === true, "The ticking switch is re-enabled");
assert(gate.detail === "server-registration-missing", `The reason is reported (got ${gate.detail})`);
assert(server.subscribeCalls === 1, "One re-registration attempt is made");

// --- 2b. server lost the file, re-registration succeeds ------------------
resetServer();
server.acceptSubscribe = true;
gate = await refreshTickGate();
assert(gate.pushSubscribed === true, "A successful re-registration restores server delivery");
assert(gate.tick === false, "Ticking goes back off after re-registration");
assert(gate.detail === "re-registered", `Re-registration is reported (got ${gate.detail})`);
assert(server.registered.has("https://push.example/device-a"), "The server now holds the subscription");

// --- 3. no subscription at all ------------------------------------------
resetServer();
pushManager.subscription = null;
gate = await refreshTickGate();
assert(gate.pushSubscribed === false, "With no subscription the gate reports unsubscribed");
assert(gate.tick === true, "In-page ticking covers a device with no push subscription");
assert(gate.detail === "no-local-subscription", `The missing subscription is reported (got ${gate.detail})`);
assert(server.verifyCalls === 0, "No pointless verify call without a local endpoint");

// --- 4. subscription created during startup ------------------------------
resetServer();
pushManager.subscription = null;
const setup = await setupWebPush();
assert(setup.ok === true, "Startup setup creates and registers a subscription");
gate = await refreshTickGate();
assert(gate.pushSubscribed === true, "The gate sees the freshly created subscription");
assert(gate.tick === false, "Ticking switches off once startup registration completes");

// --- browser tab (not standalone) keeps ticking regardless ---------------
resetServer();
globalThis.window.matchMedia = () => ({ matches: false });
globalThis.navigator.standalone = false;
gate = await refreshTickGate();
assert(gate.standalone === false, "A plain browser tab is not standalone");
assert(gate.tick === true, "A browser tab always uses the in-page timer");
assert(server.verifyCalls === 0, "A browser tab does not ask the server about registration");

if (failed) {
  console.error(`\n${failed} tick-gate check(s) failed`);
  process.exit(1);
}
console.log("\nAll tick-gate checks passed");
