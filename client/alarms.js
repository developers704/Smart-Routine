import { isNative, plugin } from "./native.js";
import { NATIVE_ALARM_CAP, buildPlan, dueItems } from "./shared/alarm-plan.js";

export { NATIVE_ALARM_CAP };

const fired = new Set();
const CHANNEL = "routine-alarms";
const TICK_WINDOW_MS = 60_000;

export async function ensurePermission({ interactive = true } = {}) {
  const LocalNotifications = plugin("LocalNotifications");
  if (LocalNotifications) {
    try {
      await LocalNotifications.createChannel?.({
        id: CHANNEL,
        name: "Alarms",
        description: "Shift, meal, study, and notepad alerts",
        importance: 5,
        visibility: 1,
        vibration: true,
        sound: "default",
      });
    } catch {
      /* web / older plugin */
    }
    if (interactive) await LocalNotifications.requestPermissions();
    return LocalNotifications;
  }
  if (interactive && !isNative() && typeof Notification !== "undefined" && Notification.permission === "default") {
    await Notification.requestPermission();
  }
  return null;
}

/** Kept for callers and tests that predate the shared planning layer. */
export function buildNotificationPlan(state, now = Date.now()) {
  return buildPlan(state, now);
}

export function tickAlarms(state) {
  if (!state || isNative()) return;
  const now = Date.now();
  for (const item of dueItems(state, now, TICK_WINDOW_MS)) {
    if (fired.has(item.id)) continue;
    fired.add(item.id);
    notify(item.title, item.body);
  }
}

function notify(title, body) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (navigator.serviceWorker?.ready) {
    navigator.serviceWorker.ready.then((reg) =>
      reg.showNotification(title, { body, icon: "/icons/icon-192.png" })
    );
  } else {
    new Notification(title, { body });
  }
}

/**
 * Idempotent: cancels only what is no longer planned and schedules only what is
 * missing, keyed on the stable identifiers from the planning layer. Safe to call
 * after every state change without piling up duplicates.
 */
export async function scheduleNative(state, LocalNotifications) {
  const api = LocalNotifications || plugin("LocalNotifications");
  if (!api) return { ok: false, reason: "no-plugin", scheduled: 0, cancelled: 0 };

  const plan = buildPlan(state);
  const wanted = new Map(plan.map((p) => [p.nativeId, p]));

  let pending = [];
  try {
    const res = await api.getPending();
    pending = res?.notifications || [];
  } catch {
    /* first launch, or plugin without getPending */
  }

  const stale = pending.filter((n) => !wanted.has(Number(n.id)));
  if (stale.length) {
    try {
      await api.cancel({ notifications: stale.map((n) => ({ id: n.id })) });
    } catch (err) {
      return { ok: false, reason: "cancel-failed", error: String(err?.message || err) };
    }
  }

  const pendingIds = new Set(pending.map((n) => Number(n.id)));
  const toSchedule = plan.filter((p) => !pendingIds.has(p.nativeId));
  if (!toSchedule.length) {
    return { ok: true, scheduled: 0, cancelled: stale.length, pending: pending.length };
  }

  const notifications = toSchedule.map((p) => ({
    id: p.nativeId,
    title: p.title,
    body: p.body,
    extra: { planId: p.id, kind: p.kind, channel: p.channel, eventId: p.eventId },
    channelId: CHANNEL,
    schedule: { at: p.at, allowWhileIdle: true },
    sound: "default",
  }));

  try {
    await api.schedule({ notifications });
    return { ok: true, scheduled: notifications.length, cancelled: stale.length };
  } catch (err) {
    let scheduled = 0;
    const errors = [];
    for (const n of notifications) {
      try {
        await api.schedule({ notifications: [n] });
        scheduled++;
      } catch (one) {
        errors.push(`${n.id}: ${String(one?.message || one)}`);
      }
    }
    return {
      ok: scheduled > 0,
      scheduled,
      cancelled: stale.length,
      reason: scheduled ? "partial" : "schedule-failed",
      error: errors.join("; ") || String(err?.message || err),
    };
  }
}

export async function getPendingNative(LocalNotifications) {
  const api = LocalNotifications || plugin("LocalNotifications");
  if (!api) return [];
  try {
    const res = await api.getPending();
    return res?.notifications || [];
  } catch {
    return [];
  }
}

export async function cancelNativeIds(ids, LocalNotifications) {
  const api = LocalNotifications || plugin("LocalNotifications");
  if (!api || !ids?.length) return false;
  try {
    await api.cancel({ notifications: ids.map((id) => ({ id })) });
    return true;
  } catch {
    return false;
  }
}
