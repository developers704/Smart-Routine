import { isNative, plugin } from "./native.js";
import {
  NATIVE_ALARM_CAP,
  buildPlan,
  dueItems,
  notificationChannelsFor,
  shouldTickInPage,
  wakeFamilyIds,
  belongsToWakeFamily,
  wakeVerificationSettings,
} from "./shared/alarm-plan.js";

export { NATIVE_ALARM_CAP };

const fired = new Set();
const CHANNEL = "routine-alarms";
const TICK_WINDOW_MS = 60_000;

let inPageTicking = true;

/** Set false once the server owns delivery for this device. */
export function setInPageTicking(enabled) {
  inPageTicking = Boolean(enabled);
}

export function inPageTickingEnabled() {
  return inPageTicking;
}

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
  if (!state || isNative() || !inPageTicking) return 0;
  const now = Date.now();
  let shown = 0;
  for (const item of dueItems(state, now, TICK_WINDOW_MS)) {
    if (fired.has(item.id)) continue;
    fired.add(item.id);
    notify(item.title, item.body);
    shown++;
  }
  return shown;
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

function pendingContent(n) {
  return {
    planId: n?.extra?.planId ?? null,
    title: n?.title ?? "",
    body: n?.body ?? "",
  };
}

function contentMatches(pending, item) {
  const c = pendingContent(pending);
  if (c.planId && c.planId !== item.id) return false;
  return c.title === item.title && c.body === item.body;
}

function toNotification(p) {
  const n = {
    id: p.nativeId,
    title: p.title,
    body: p.body,
    extra: { planId: p.id, kind: p.kind, channel: p.channel, eventId: p.eventId },
    channelId: CHANNEL,
    schedule: { at: p.at, allowWhileIdle: true },
    sound: "default",
  };
  if (p.channel === "alarm") n.interruptionLevel = "timeSensitive";
  return n;
}

/**
 * Idempotent sync. Cancels what is no longer planned, reschedules entries whose
 * title or body changed, and schedules what is missing — all keyed on the stable
 * identifiers from the planning layer.
 *
 * @param {object} state
 * @param {object|null} LocalNotifications
 * @param {object} [opts]
 * @param {string[]} [opts.channels]  which plan channels this scheduler owns
 */
export async function scheduleNative(state, LocalNotifications, opts = {}) {
  const api = LocalNotifications || plugin("LocalNotifications");
  if (!api) return { ok: false, reason: "no-plugin", scheduled: 0, cancelled: 0, updated: 0 };

  const now = opts.now ?? Date.now();
  const channels = opts.channels || notificationChannelsFor(opts);
  let plan = buildPlan(state, now, {
    channels,
    protectPrimaryId: opts.protectPrimaryId || null,
    extraBackupCount: opts.extraBackupCount,
  });
  const leftover = new Set(opts.leftoverAlarmIds || []);
  if (opts.alarmKitOwnsAlarms) {
    plan = plan.filter((p) => p.channel !== "alarm");
  } else if (leftover.size && channels.includes("alarm")) {
    plan = plan.filter((p) => p.channel !== "alarm" || leftover.has(p.id));
  }
  const family = new Set(
    opts.protectPrimaryId
      ? wakeFamilyIds(
          opts.protectPrimaryId,
          opts.extraBackupCount ?? wakeVerificationSettings(state?.settings).backupCount
        )
      : []
  );
  const protectedId = (planId) => belongsToWakeFamily(planId, opts.protectPrimaryId) || family.has(planId);
  const wanted = new Map(plan.map((p) => [p.nativeId, p]));

  let pending = [];
  try {
    const res = await api.getPending();
    pending = res?.notifications || [];
  } catch {
    /* first launch, or plugin without getPending */
  }

  const stale = [];
  const changed = [];
  for (const n of pending) {
    const item = wanted.get(Number(n.id));
    if (!item) {
      if (protectedId(n?.extra?.planId)) continue;
      stale.push(n);
    } else if (!contentMatches(n, item)) {
      if (protectedId(item.id) && item.at.getTime() <= now) continue;
      changed.push(item);
    }
  }

  const toCancel = [...stale.map((n) => Number(n.id)), ...changed.map((p) => p.nativeId)];
  if (toCancel.length) {
    try {
      await api.cancel({ notifications: toCancel.map((id) => ({ id })) });
    } catch (err) {
      return { ok: false, reason: "cancel-failed", error: String(err?.message || err) };
    }
  }

  const stillPending = new Set(
    pending.map((n) => Number(n.id)).filter((id) => !toCancel.includes(id))
  );
  const toSchedule = plan.filter((p) => {
    if (stillPending.has(p.nativeId)) return false;
    if (protectedId(p.id) && p.at.getTime() <= now) return false;
    return true;
  });
  if (!toSchedule.length) {
    return { ok: true, scheduled: 0, updated: 0, cancelled: stale.length, pending: pending.length };
  }

  const notifications = toSchedule.map(toNotification);
  try {
    await api.schedule({ notifications });
    return {
      ok: true,
      scheduled: notifications.length - changed.length,
      updated: changed.length,
      cancelled: stale.length,
    };
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
      updated: 0,
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

export { shouldTickInPage };
