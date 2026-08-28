import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { buildNotificationPlan } from "../client/alarms.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const subFile = path.join(root, "data", "push-subscription.json");

let subscription = null;
const sent = new Map();
const SENT_TTL_MS = 48 * 60 * 60 * 1000;
const TICK_MS = 30_000;
const FIRE_WINDOW_MS = 45_000;

let tickTimer = null;
let getState = async () => ({});

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || "";
}

export function initPush(loadState) {
  getState = loadState;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@smartroutine.valliani.app";
  if (!pub || !priv) {
    console.warn("Web Push: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY for iPhone background alarms");
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  loadSubscription()
    .then(() => startScheduler())
    .catch(() => startScheduler());
  return true;
}

export async function loadSubscription() {
  try {
    const raw = await readFile(subFile, "utf8");
    subscription = JSON.parse(raw);
  } catch {
    subscription = null;
  }
  return subscription;
}

async function persistSubscription(sub) {
  await mkdir(path.dirname(subFile), { recursive: true });
  if (!sub) {
    subscription = null;
    try {
      await writeFile(subFile, "{}", "utf8");
    } catch {
      /* ignore */
    }
    return;
  }
  subscription = sub;
  await writeFile(subFile, JSON.stringify(sub, null, 2), "utf8");
}

export async function saveSubscription(sub) {
  await persistSubscription(sub);
}

export async function clearSubscription() {
  await persistSubscription(null);
}

export function startScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    tickPush().catch((err) => console.error("push tick:", err.message));
  }, TICK_MS);
  tickPush().catch(() => {});
}

export async function tickPush(now = Date.now()) {
  if (!subscription || !getVapidPublicKey()) return;
  pruneSent(now);
  const state = await getState();
  const plan = buildNotificationPlan(state, now);
  for (const p of plan) {
    const at = p.at.getTime();
    if (at > now || at <= now - FIRE_WINDOW_MS) continue;
    const key = `${p.eventId}:${p.kind}:${at}`;
    if (sent.has(key)) continue;
    sent.set(key, now);
    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify({ title: p.title, body: p.body, tag: key })
      );
    } catch (err) {
      sent.delete(key);
      if (err.statusCode === 404 || err.statusCode === 410) {
        await clearSubscription();
      } else {
        console.error("push send:", err.message);
      }
    }
  }
}

function pruneSent(now) {
  for (const [key, t] of sent) {
    if (now - t > SENT_TTL_MS) sent.delete(key);
  }
}
