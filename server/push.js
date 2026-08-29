import { readFile, unlink } from "node:fs/promises";
import webpush from "web-push";
import { dueItems } from "../client/shared/alarm-plan.js";
import { cleanupStaleTemps, withFileLock, writeJsonAtomic, writeJsonNow } from "./atomic-write.js";
import { dataFile } from "./paths.js";

const subsFile = () => dataFile("push-subscriptions.json");
const legacyFile = () => dataFile("push-subscription.json");
const deliveryFile = () => dataFile("push-delivery.json");

const DELIVERY_TTL_MS = 48 * 60 * 60 * 1000;
const TICK_MS = 30_000;
const FIRE_WINDOW_MS = 45_000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [15_000, 60_000, 180_000];

/** endpoint -> subscription */
let subscriptions = new Map();
/** `${itemId}\u0000${endpoint}` -> delivered-at epoch */
let delivered = new Map();
/** same key -> { endpoint, itemId, payload, attempts, nextAt } */
let retries = new Map();

let tickTimer = null;
let getState = async () => ({});
let vapidReady = false;
let deliveryDirty = false;
let persistEnabled = true;
let tickChain = Promise.resolve();

export function getVapidPublicKey() {
  return vapidReady ? process.env.VAPID_PUBLIC_KEY || "" : "";
}

export function isPushConfigured() {
  return vapidReady;
}

function deliveryKey(itemId, endpoint) {
  return `${itemId}\u0000${endpoint}`;
}

/** Rejects anything the push service could not actually accept. */
export function isValidSubscription(sub) {
  if (!sub || typeof sub !== "object") return false;
  if (typeof sub.endpoint !== "string" || !/^https:\/\/[^\s]+$/.test(sub.endpoint)) return false;
  if (sub.endpoint.length > 1024) return false;
  const keys = sub.keys;
  if (!keys || typeof keys !== "object") return false;
  if (typeof keys.p256dh !== "string" || keys.p256dh.length < 16 || keys.p256dh.length > 256) return false;
  if (typeof keys.auth !== "string" || keys.auth.length < 8 || keys.auth.length > 128) return false;
  return true;
}

/** Accepts the legacy single object, the new array, or junk like `{}`. */
export function parseSubscriptionFile(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : [data];
  return list.filter(isValidSubscription);
}

export function mergeSubscriptions(existing, incoming) {
  const byEndpoint = new Map(existing.map((s) => [s.endpoint, s]));
  for (const sub of incoming) {
    if (!isValidSubscription(sub)) continue;
    byEndpoint.set(sub.endpoint, sub);
  }
  return [...byEndpoint.values()];
}

export function listSubscriptions() {
  return [...subscriptions.values()];
}

export function subscriptionCount() {
  return subscriptions.size;
}

export function hasSubscription(endpoint) {
  return subscriptions.has(endpoint);
}

function writeSubscriptions() {
  return writeJsonAtomic(subsFile(), listSubscriptions());
}

/** Migrates any usable legacy subscription instead of dropping it. */
export async function loadSubscriptions() {
  return withFileLock(subsFile(), async () => {
    let list = [];
    let migrated = false;
    try {
      list = parseSubscriptionFile(await readFile(subsFile(), "utf8"));
    } catch {
      list = [];
    }
    if (!list.length) {
      try {
        const legacy = parseSubscriptionFile(await readFile(legacyFile(), "utf8"));
        if (legacy.length) {
          list = legacy;
          migrated = true;
        }
      } catch {
        /* no legacy file */
      }
    }
    subscriptions = new Map(list.map((s) => [s.endpoint, s]));
    if (migrated) {
      await writeJsonNow(subsFile(), list);
      await unlink(legacyFile()).catch(() => {});
      console.log(`Web Push: migrated ${list.length} legacy subscription(s)`);
    }
    return listSubscriptions();
  });
}

export async function saveSubscription(sub) {
  if (!isValidSubscription(sub)) return { ok: false, error: "invalid-subscription" };
  subscriptions.set(sub.endpoint, sub);
  await writeSubscriptions();
  return { ok: true, count: subscriptions.size };
}

export async function removeSubscription(endpoint) {
  if (!endpoint || !subscriptions.delete(endpoint)) return false;
  for (const [key, r] of retries) {
    if (r.endpoint === endpoint) retries.delete(key);
  }
  await writeSubscriptions();
  return true;
}

export async function clearSubscriptions() {
  subscriptions = new Map();
  retries = new Map();
  await writeSubscriptions();
}

/** Delivery receipts survive restarts so PM2 cycles cannot resend. */
export async function loadDelivery(now = Date.now()) {
  try {
    const raw = JSON.parse(await readFile(deliveryFile(), "utf8"));
    const entries = Array.isArray(raw) ? raw : [];
    delivered = new Map(
      entries
        .filter((e) => e && typeof e.key === "string" && Number.isFinite(e.at) && now - e.at < DELIVERY_TTL_MS)
        .map((e) => [e.key, e.at])
    );
  } catch {
    delivered = new Map();
  }
  return delivered.size;
}

async function persistDelivery() {
  if (!deliveryDirty || !persistEnabled) return;
  deliveryDirty = false;
  const entries = [...delivered.entries()].map(([key, at]) => ({ key, at }));
  await writeJsonAtomic(deliveryFile(), entries).catch((err) =>
    console.error("push delivery persist:", err.message)
  );
}

function markDelivered(key, now) {
  delivered.set(key, now);
  deliveryDirty = true;
}

function pruneDelivery(now) {
  for (const [key, at] of delivered) {
    if (now - at > DELIVERY_TTL_MS) {
      delivered.delete(key);
      deliveryDirty = true;
    }
  }
}

export function initPush(loadState) {
  getState = loadState;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@smartroutine.valliani.app";
  if (!pub || !priv) {
    console.warn("Web Push: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY for PWA background reminders");
    return false;
  }
  try {
    webpush.setVapidDetails(subject, pub, priv);
  } catch (err) {
    // A malformed key must disable push, never take the whole server down.
    vapidReady = false;
    console.error(`Web Push disabled — invalid VAPID configuration: ${err.message}`);
    return false;
  }
  vapidReady = true;
  Promise.all([
    loadSubscriptions().catch(() => {}),
    loadDelivery().catch(() => {}),
    cleanupStaleTemps(subsFile()).catch(() => {}),
    cleanupStaleTemps(deliveryFile()).catch(() => {}),
  ]).finally(() => startScheduler());
  return true;
}

export function startScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    tickPush().catch((err) => console.error("push tick:", err.message));
  }, TICK_MS);
  tickTimer.unref?.();
  tickPush().catch(() => {});
}

export function stopScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

function defaultSender(sub, payload) {
  return webpush.sendNotification(sub, payload);
}

/** "ok" | "gone" | "fail" — only 404/410 mean the endpoint is retired. */
async function sendOne(sub, payload, sender) {
  try {
    await (sender || defaultSender)(sub, JSON.stringify(payload));
    return { outcome: "ok" };
  } catch (err) {
    const code = err?.statusCode;
    if (code === 404 || code === 410) return { outcome: "gone" };
    return { outcome: "fail", error: String(err?.message || err) };
  }
}

/**
 * Fans one payload out to every subscription. Kept exported for tests and
 * for the device-scoped test push.
 */
export async function sendToAll(subs, payload, sender) {
  const out = { delivered: [], gone: [], failed: [] };
  for (const sub of subs) {
    const res = await sendOne(sub, payload, sender);
    if (res.outcome === "ok") out.delivered.push(sub.endpoint);
    else if (res.outcome === "gone") out.gone.push(sub.endpoint);
    else out.failed.push({ endpoint: sub.endpoint, error: res.error });
  }
  return out;
}

function scheduleRetry(key, { endpoint, itemId, payload }, attempts, now) {
  if (attempts >= MAX_ATTEMPTS) {
    retries.delete(key);
    console.error(`push give-up after ${attempts} attempts: ${itemId} -> ${endpoint}`);
    return;
  }
  const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)];
  retries.set(key, { endpoint, itemId, payload, attempts, nextAt: now + backoff });
}

async function attempt(key, entry, now, sender) {
  const sub = subscriptions.get(entry.endpoint);
  if (!sub) {
    retries.delete(key);
    return "dropped";
  }
  const res = await sendOne(sub, entry.payload, sender);
  if (res.outcome === "ok") {
    retries.delete(key);
    markDelivered(key, now);
    return "ok";
  }
  if (res.outcome === "gone") {
    retries.delete(key);
    await removeSubscription(entry.endpoint);
    return "gone";
  }
  scheduleRetry(key, entry, (entry.attempts || 0) + 1, now);
  return "fail";
}

/**
 * Delivery is tracked per item *and* endpoint, so one device failing does not
 * suppress the others and does not mark the item done for everyone.
 *
 * Ticks are serialized: the scheduled interval, the startup tick and the
 * state-change ticks all share this queue, so two overlapping runs cannot both
 * see an item as undelivered and send it twice.
 */
export function tickPush(now = Date.now(), sender) {
  const run = tickChain.then(
    () => runTick(now, sender),
    () => runTick(now, sender)
  );
  tickChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function runTick(now, sender) {
  if (!vapidReady) return { sent: 0, due: 0, retried: 0, failed: 0 };
  pruneDelivery(now);

  let retried = 0;
  let failed = 0;
  let sent = 0;

  for (const [key, entry] of [...retries]) {
    if (entry.nextAt > now) continue;
    retried++;
    const outcome = await attempt(key, entry, now, sender);
    if (outcome === "ok") sent++;
    else if (outcome === "fail") failed++;
  }

  let due = [];
  if (subscriptions.size) {
    const state = await getState();
    due = dueItems(state, now, FIRE_WINDOW_MS);
    for (const item of due) {
      const payload = { title: item.title, body: item.body, tag: item.id };
      for (const endpoint of [...subscriptions.keys()]) {
        const key = deliveryKey(item.id, endpoint);
        if (delivered.has(key) || retries.has(key)) continue;
        // Claim the slot before awaiting so a queued tick cannot re-send it.
        markDelivered(key, now);
        const outcome = await attempt(key, { endpoint, itemId: item.id, payload, attempts: 0 }, now, sender);
        if (outcome === "ok") sent++;
        else {
          delivered.delete(key);
          if (outcome === "fail") failed++;
        }
      }
    }
  }

  await persistDelivery();
  return { sent, due: due.length, retried, failed, pendingRetries: retries.size };
}

/** Test pushes target one device, never everybody. */
const testTimers = new Map();

export function scheduleTestPush({ minutes = 2, endpoint } = {}, sender) {
  if (!vapidReady) return { ok: false, error: "vapid-not-configured" };
  if (!subscriptions.size) return { ok: false, error: "no-subscriptions" };
  if (!endpoint) return { ok: false, error: "endpoint-required" };
  const sub = subscriptions.get(endpoint);
  if (!sub) return { ok: false, error: "unknown-endpoint" };

  cancelTestPush(endpoint);
  const mins = Math.min(60, Math.max(1, Number(minutes) || 2));
  const delay = mins * 60000;
  const at = new Date(Date.now() + delay);
  const timer = setTimeout(() => {
    testTimers.delete(endpoint);
    sendOne(
      sub,
      { title: "Smart Routine test", body: `Scheduled ${mins} minutes ago. Notifications work.`, tag: "routine-test" },
      sender
    ).then((res) => {
      if (res.outcome === "gone") return removeSubscription(endpoint);
      if (res.outcome === "fail") console.error("test push:", res.error);
      return undefined;
    });
  }, delay);
  timer.unref?.();
  testTimers.set(endpoint, timer);
  return { ok: true, at: at.toISOString(), minutes: mins };
}

export function cancelTestPush(endpoint) {
  if (!endpoint) return false;
  const timer = testTimers.get(endpoint);
  if (!timer) return false;
  clearTimeout(timer);
  testTimers.delete(endpoint);
  return true;
}

export function pendingTestPushes() {
  return testTimers.size;
}

// --- test seams -----------------------------------------------------------

export function resetSentForTest() {
  delivered = new Map();
  retries = new Map();
  deliveryDirty = false;
}

export function setSubscriptionsForTest(list) {
  subscriptions = new Map(list.map((s) => [s.endpoint, s]));
}

export function setStateLoaderForTest(fn) {
  getState = fn;
}

export function setVapidReadyForTest(value) {
  vapidReady = value;
}

export function deliveryStateForTest() {
  return { delivered: new Map(delivered), retries: new Map(retries) };
}

export function loadDeliveryForTest(entries) {
  delivered = new Map(entries.map(([key, at]) => [key, at]));
}

export function setPersistenceForTest(enabled) {
  persistEnabled = enabled;
}

export function deliveryFilePath() {
  return deliveryFile();
}

export function subscriptionsFilePath() {
  return subsFile();
}
