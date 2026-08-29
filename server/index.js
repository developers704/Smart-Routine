import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, saveState } from "./store.js";
import { planRange, warningsFor, mergePlan } from "../client/shared/scheduler.js";
import { addDays, isoDate } from "../client/shared/time.js";
import {
  cancelTestPush,
  getVapidPublicKey,
  initPush,
  removeSubscription,
  saveSubscription,
  scheduleTestPush,
  subscriptionCount,
  tickPush,
} from "./push.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(root, "client")));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/state", async (_req, res) => {
  res.json(await loadState());
});

app.put("/api/state", async (req, res) => {
  await saveState(req.body);
  tickPush().catch(() => {});
  res.json({ ok: true });
});

app.post("/api/plan", async (req, res) => {
  const state = await loadState();
  const from = req.body.from || isoDate(new Date());
  const to = req.body.to || addDays(from, 13);
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
});

app.get("/api/push/vapid-public-key", (_req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

app.post("/api/push/subscribe", async (req, res) => {
  if (!getVapidPublicKey()) {
    res.status(503).json({ ok: false, error: "vapid-not-configured" });
    return;
  }
  if (!req.body?.endpoint) {
    res.status(400).json({ ok: false, error: "invalid-subscription" });
    return;
  }
  const saved = await saveSubscription(req.body);
  tickPush().catch(() => {});
  res.json({ ok: saved.ok, devices: subscriptionCount() });
});

app.delete("/api/push/subscribe", async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) {
    res.status(400).json({ ok: false, error: "endpoint-required" });
    return;
  }
  const removed = await removeSubscription(endpoint);
  res.json({ ok: true, removed, devices: subscriptionCount() });
});

app.get("/api/push/status", (_req, res) => {
  res.json({ configured: Boolean(getVapidPublicKey()), devices: subscriptionCount() });
});

app.post("/api/push/test", (req, res) => {
  if (!getVapidPublicKey()) {
    res.status(503).json({ ok: false, error: "vapid-not-configured" });
    return;
  }
  const minutes = Number(req.body?.minutes) || 2;
  const out = scheduleTestPush(minutes);
  if (!out.ok) {
    res.status(409).json(out);
    return;
  }
  res.json(out);
});

app.delete("/api/push/test", (_req, res) => {
  res.json({ ok: true, cancelled: cancelTestPush() });
});

const port = Number(process.env.PORT) || 4173;
initPush(loadState);
app.listen(port, () => {
  console.log(`Routine running at http://localhost:${port}`);
});
