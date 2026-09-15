import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, saveState } from "./store.js";
import { createApnsSender } from "./apns.js";
import { readFile } from "node:fs/promises";
import {
  familyAuthToken,
  loadFamilyService,
  mountFamilyRoutes,
  persistFamilyService,
} from "./family.js";
import { fillEmptyWeeksInRange } from "../client/shared/defaults.js";
import { planRange, warningsFor, mergePlan } from "../client/shared/scheduler.js";
import { addDays, isoDate } from "../client/shared/time.js";
import { asyncRoute, jsonErrorHandler } from "./async-route.js";
import { rateLimit } from "./rate-limit.js";
import {
  cancelTestPush,
  getVapidPublicKey,
  hasSubscription,
  initPush,
  isPushReady,
  isValidSubscription,
  removeSubscription,
  saveSubscription,
  scheduleTestPush,
  sendToAll,
  listSubscriptionsForUser,
  subscriptionCount,
  tickPush,
} from "./push.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.get(["/privacy-policy", "/privacy-policy/"], (_req, res) => {
  res.sendFile(path.join(root, "client", "privacy-policy.html"));
});
app.get(["/support", "/support/"], (_req, res) => {
  res.sendFile(path.join(root, "client", "support.html"));
});
app.use(express.static(path.join(root, "client")));

const pushLimiter = rateLimit({ max: 20, windowMs: 60_000, name: "push" });
const testLimiter = rateLimit({ max: 5, windowMs: 5 * 60_000, name: "push-test" });
const stateLimiter = rateLimit({ max: 120, windowMs: 60_000, name: "state" });
const loginLimiter = rateLimit({ max: 8, windowMs: 15 * 60_000, name: "family-login" });

/** Push state lives in files; refuse to touch it until those files are loaded. */
function requirePushReady(_req, res, next) {
  if (!isPushReady()) {
    res.status(503).json({ ok: false, error: "starting-up" });
    return;
  }
  next();
}

const apnsKey = process.env.APNS_KEY_P8
  ? process.env.APNS_KEY_P8.replace(/\\n/g, "\n")
  : process.env.APNS_KEY_FILE
    ? await readFile(process.env.APNS_KEY_FILE, "utf8").catch(() => "")
    : "";
const apnsSender = createApnsSender({
  p8: apnsKey,
  keyId: process.env.APNS_KEY_ID || "",
  teamId: process.env.APNS_TEAM_ID || "",
  bundleId: process.env.APNS_BUNDLE_ID || "app.routine.calendar",
  production: process.env.APNS_PRODUCTION === "1",
});

let familyService;
familyService = await loadFamilyService({
  sendPush: async ({ userId, payload }) => {
    for (const deviceToken of familyService.listApnsForUser(userId)) {
      const result = await apnsSender.send({
        deviceToken,
        title: payload.title,
        body: payload.body,
        sound: true,
      });
      if (result.invalid) {
        familyService.removeApnsToken(deviceToken);
        await persistFamilyService();
      }
    }
    const subs = listSubscriptionsForUser(userId);
    if (!subs.length) return;
    await sendToAll(subs, {
      title: payload.title,
      body: payload.body,
      sound: true,
      tag: `family-home-${payload.kind}`,
    });
  },
});
mountFamilyRoutes(app, {
  limiter: stateLimiter,
  loginLimiter,
  service: familyService,
  persist: persistFamilyService,
});

app.get("/api/health", (_req, res) => res.json({ ok: true, pushReady: isPushReady() }));

app.get(
  "/api/state",
  stateLimiter,
  asyncRoute(async (_req, res) => {
    res.json(await loadState());
  })
);

app.put(
  "/api/state",
  stateLimiter,
  asyncRoute(async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({ ok: false, error: "invalid-state" });
      return;
    }
    await saveState(req.body);
    tickPush().catch(() => {});
    res.json({ ok: true });
  })
);

app.post(
  "/api/plan",
  stateLimiter,
  asyncRoute(async (req, res) => {
    const state = await loadState();
    const from = req.body?.from || isoDate(new Date());
    const to = req.body?.to || addDays(from, 13);
    state.shifts = fillEmptyWeeksInRange(state.shifts || {}, from, to);
    const prev = state.events || [];
    const userEvents = prev.filter((e) => e.source === "user");
    const keep = prev.filter((e) => e.source === "auto" && e.locked);
    const generated = planRange({
      shifts: state.shifts || {},
      userEvents,
      keep,
      settings: state.settings,
      from,
      to,
    });
    state.events = mergePlan(prev, generated, from, to);
    state.generatedAt = new Date().toISOString();
    state.warnings = warningsFor(generated, state.shifts || {}, state.settings);
    await saveState(state);
    tickPush().catch(() => {});
    res.json(state);
  })
);

app.get("/api/push/vapid-public-key", (_req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

app.post(
  "/api/push/subscribe",
  pushLimiter,
  requirePushReady,
  asyncRoute(async (req, res) => {
    if (!getVapidPublicKey()) {
      res.status(503).json({ ok: false, error: "vapid-not-configured" });
      return;
    }
    const sub = { ...req.body };
    const sessionUser = familyService.userFromToken(familyAuthToken(req));
    if (sessionUser) sub.userId = sessionUser.id;
    if (!isValidSubscription(sub)) {
      res.status(400).json({ ok: false, error: "invalid-subscription" });
      return;
    }
    const saved = await saveSubscription(sub);
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }
    tickPush().catch(() => {});
    res.json({ ok: true, devices: subscriptionCount() });
  })
);

app.delete(
  "/api/push/subscribe",
  pushLimiter,
  requirePushReady,
  asyncRoute(async (req, res) => {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== "string" || !endpoint) {
      res.status(400).json({ ok: false, error: "endpoint-required" });
      return;
    }
    const removed = await removeSubscription(endpoint);
    res.json({ ok: true, removed, devices: subscriptionCount() });
  })
);

app.get("/api/push/status", (_req, res) => {
  res.json({
    configured: Boolean(getVapidPublicKey()),
    devices: subscriptionCount(),
    ready: isPushReady(),
  });
});

/** Lets a device confirm the server really holds its subscription. */
app.post("/api/push/verify", pushLimiter, requirePushReady, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== "string" || !endpoint) {
    res.status(400).json({ ok: false, error: "endpoint-required" });
    return;
  }
  res.json({
    ok: true,
    registered: Boolean(getVapidPublicKey()) && hasSubscription(endpoint),
    configured: Boolean(getVapidPublicKey()),
  });
});

/** Device-scoped: a test only ever goes to the calling device's endpoint. */
app.post("/api/push/test", testLimiter, requirePushReady, (req, res) => {
  if (!getVapidPublicKey()) {
    res.status(503).json({ ok: false, error: "vapid-not-configured" });
    return;
  }
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== "string" || !endpoint) {
    res.status(400).json({ ok: false, error: "endpoint-required" });
    return;
  }
  if (!hasSubscription(endpoint)) {
    res.status(404).json({ ok: false, error: "unknown-endpoint" });
    return;
  }
  const out = scheduleTestPush({ minutes: req.body?.minutes, endpoint });
  res.status(out.ok ? 200 : 409).json(out);
});

app.delete("/api/push/test", testLimiter, requirePushReady, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== "string" || !endpoint) {
    res.status(400).json({ ok: false, error: "endpoint-required" });
    return;
  }
  res.json({ ok: true, cancelled: cancelTestPush(endpoint) });
});

app.use(jsonErrorHandler);

const port = Number(process.env.PORT) || 4173;

// Load push state before listening so no request sees a half-populated store.
const pushInit = await initPush(loadState).catch((err) => {
  console.error("Web Push startup failed:", err.message);
  return { ready: true, configured: false, reason: "startup-error" };
});

app.listen(port, () => {
  console.log(`Routine running at http://localhost:${port}`);
  if (!pushInit.configured) console.log(`Web Push inactive (${pushInit.reason || "unknown"})`);
});
