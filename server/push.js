import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { dueItems } from "../client/shared/alarm-plan.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const subsFile = path.join(dataDir, "push-subscriptions.json");
const legacyFile = path.join(dataDir, "push-subscription.json");

const SENT_TTL_MS = 48 * 60 * 60 * 1000;
const TICK_MS = 30_000;
const FIRE_WINDOW_MS = 45_000;

/** endpoint -> subscription */
let subscriptions = new Map();
const sent = new Map();
let tickTimer = null;
let getState = async () => ({});
let vapidReady = false;

export function getVapidPublicKey() {
  return vapidReady ? process.env.VAPID_PUBLIC_KEY || "" : "";
}

/** True once a valid key pair has been accepted by web-push. */
export function isPushConfigured() {
  return vapidReady;
}

export function setVapidReadyForTest(value) {
  vapidReady = value;
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
  return list.filter((s) => s && typeof s.endpoint === "string" && s.endpoint);
}

export function mergeSubscriptions(existing, incoming) {
  const byEndpoint = new Map(existing.map((s) => [s.endpoint, s]));
  for (const sub of incoming) {
    if (!sub?.endpoint) continue;
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

async function writeSubscriptions() {
  await mkdir(dataDir, { recursive: true });
  const tmp = `${subsFile}.tmp`;
  await writeFile(tmp, JSON.stringify(listSubscriptions(), null, 2), "utf8");
  await rename(tmp, subsFile);
}

/** Migrates any usable legacy subscription instead of dropping it. */
export async function loadSubscriptions() {
  let list = [];
  let migrated = false;
  try {
    list = parseSubscriptionFile(await readFile(subsFile, "utf8"));
  } catch {
    list = [];
  }
  if (!list.length) {
    try {
      const legacy = parseSubscriptionFile(await readFile(legacyFile, "utf8"));
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
    await writeSubscriptions();
    await unlink(legacyFile).catch(() => {});
    console.log(`Web Push: migrated ${list.length} legacy subscription(s)`);
  }
  return listSubscriptions();
}

export async function saveSubscription(sub) {
  if (!sub?.endpoint) return { ok: false, error: "invalid-subscription" };
  subscriptions.set(sub.endpoint, sub);
  await writeSubscriptions();
  return { ok: true, count: subscriptions.size };
}

export async function removeSubscription(endpoint) {
  if (!endpoint || !subscriptions.delete(endpoint)) return false;
  await writeSubscriptions();
  return true;
}

export async function clearSubscriptions() {
  subscriptions = new Map();
  await writeSubscriptions();
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
  loadSubscriptions()
    .catch(() => {})
    .finally(() => startScheduler());
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

/**
 * Fans one payload out to every stored subscription, pruning the ones the push
 * service has retired. `sender` is injectable so tests need no network.
 */
export async function sendToAll(subs, payload, sender = webpush.sendNotification.bind(webpush)) {
  const delivered = [];
  const gone = [];
  const failed = [];
  for (const sub of subs) {
    try {
      await sender(sub, JSON.stringify(payload));
      delivered.push(sub.endpoint);
    } catch (err) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) gone.push(sub.endpoint);
      else failed.push({ endpoint: sub.endpoint, error: String(err?.message || err) });
    }
  }
  return { delivered, gone, failed };
}

export async function tickPush(now = Date.now(), sender) {
  if (!subscriptions.size || !getVapidPublicKey()) return { sent: 0 };
  pruneSent(now);
  const state = await getState();
  const due = dueItems(state, now, FIRE_WINDOW_MS);
  let count = 0;
  for (const item of due) {
    if (sent.has(item.id)) continue;
    sent.set(item.id, now);
    const res = await sendToAll(
      listSubscriptions(),
      { title: item.title, body: item.body, tag: item.id },
      sender
    );
    for (const endpoint of res.gone) await removeSubscription(endpoint);
    for (const f of res.failed) console.error("push send:", f.endpoint, f.error);
    if (res.delivered.length) count++;
    else if (!res.gone.length && res.failed.length) sent.delete(item.id);
  }
  return { sent: count, due: due.length };
}

function pruneSent(now) {
  for (const [key, t] of sent) {
    if (now - t > SENT_TTL_MS) sent.delete(key);
  }
}

let testTimer = null;

export function scheduleTestPush(minutes = 2, sender) {
  cancelTestPush();
  if (!subscriptions.size) return { ok: false, error: "no-subscriptions" };
  const delay = Math.max(1, minutes) * 60000;
  const at = new Date(Date.now() + delay);
  testTimer = setTimeout(() => {
    testTimer = null;
    sendToAll(
      listSubscriptions(),
      {
        title: "Smart Routine test",
        body: `Scheduled ${minutes} minutes ago. Notifications work.`,
        tag: "routine-test",
      },
      sender
    )
      .then(({ gone }) => Promise.all(gone.map((e) => removeSubscription(e))))
      .catch((err) => console.error("test push:", err.message));
  }, delay);
  testTimer.unref?.();
  return { ok: true, at: at.toISOString() };
}

export function cancelTestPush() {
  if (!testTimer) return false;
  clearTimeout(testTimer);
  testTimer = null;
  return true;
}

export function resetSentForTest() {
  sent.clear();
}

export function setSubscriptionsForTest(list) {
  subscriptions = new Map(list.map((s) => [s.endpoint, s]));
}

export function setStateLoaderForTest(fn) {
  getState = fn;
}
