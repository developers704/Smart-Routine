/**
 * Pure planning layer for notifications and alarms.
 *
 * No DOM, no Capacitor, no network — so the same code runs in the browser, in
 * the Express server (for Web Push) and in the Node test suites.
 *
 * Two delivery channels come out of here:
 *   "alarm"        — important, must break through silent/focus (AlarmKit on iOS 26+)
 *   "notification" — ordinary reminders (local notifications / Web Push)
 */

import { addZonedDays, clockLabel, epochForZonedTime, resolveTimeZone, zonedParts } from "./tz.js";

/** iOS keeps at most 64 pending local notifications. */
export const NATIVE_ALARM_CAP = 64;

export const ALARM_ROLES = {
  WAKE: "wake",
  SHIFT: "shift",
  LEAVE: "leave",
};
const ROLE_SETTING = {
  [ALARM_ROLES.WAKE]: "wakeAlarms",
  [ALARM_ROLES.SHIFT]: "shiftAlarms",
  [ALARM_ROLES.LEAVE]: "leaveAlarms",
};

const SLEEP_KINDS = new Set(["sleep", "recovery"]);

function alarmsEnabled(settings) {
  return settings?.alarmsEnabled !== false;
}

export function roleEnabled(role, settings) {
  if (!alarmsEnabled(settings)) return false;
  const key = ROLE_SETTING[role];
  if (!key) return false;
  return settings?.[key] !== false;
}

/** Which alarm role an event maps to, or null for ordinary events. */
export function alarmRole(event) {
  if (!event) return null;
  if (event.kind === "leave") return ALARM_ROLES.LEAVE;
  if (event.kind === "work" || event.category === "work") return ALARM_ROLES.SHIFT;
  return null;
}

/** "alarm" | "notification" | "none" */
export function classifyEvent(event, settings = {}) {
  if (!event) return "none";
  if (event.done) return "none";
  if (event.alarm === false) return "none";
  const role = alarmRole(event);
  if (role && roleEnabled(role, settings)) return "alarm";
  return "notification";
}

/**
 * Wake-ups have no event of their own — the scheduler models them as the end of
 * a sleep or recovery block.
 */
export function deriveWakeAlarms(events = [], settings = {}) {
  if (!roleEnabled(ALARM_ROLES.WAKE, settings)) return [];
  const out = [];
  for (const e of events) {
    if (!SLEEP_KINDS.has(e.kind)) continue;
    if (e.done || e.alarm === false) continue;
    const end = new Date(e.end).getTime();
    if (!Number.isFinite(end)) continue;
    out.push({
      eventId: e.id,
      role: ALARM_ROLES.WAKE,
      at: end,
      title: "Wake up",
      body: `End of ${String(e.title || "sleep").toLowerCase()}`,
    });
  }
  return out;
}

/**
 * Stable across regeneration and app restarts: the same event at the same time
 * always produces the same identifier, so syncing can never duplicate.
 */
export function planItemId({ eventId, kind, at }) {
  const ms = at instanceof Date ? at.getTime() : Number(at);
  return `${eventId}:${kind}:${ms}`;
}

/** Capacitor and UNNotificationRequest want a positive 32-bit integer. */
export function numericId(id) {
  let h = 0x811c9dc5;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2147483647 || 1;
}

function clockOf(ms, timeZone) {
  return clockLabel(ms, timeZone);
}

function eventBody(e, timeZone) {
  const when = clockOf(new Date(e.start).getTime(), timeZone);
  return `${when}${e.subtitle ? " · " + e.subtitle : ""}`;
}

/**
 * The reminder for "today" stays eligible while it is still inside the due
 * window, otherwise a tick a few seconds late would roll it to tomorrow and the
 * notepad ping would never be delivered.
 */
export function nextNotepadAt(remindMin, now, { floor = now, timeZone } = {}) {
  const tz = timeZone || resolveTimeZone();
  const hour = Math.floor(remindMin / 60);
  const minute = remindMin % 60;
  const today = zonedParts(now, tz);
  const todayAt = epochForZonedTime(tz, { year: today.year, month: today.month, day: today.day, hour, minute });
  if (todayAt > floor) return new Date(todayAt);
  const tomorrow = addZonedDays(today, 1);
  return new Date(epochForZonedTime(tz, { ...tomorrow, hour, minute }));
}

function makeItem({ eventId, role, kind, channel, at, title, body }) {
  const ms = at instanceof Date ? at.getTime() : Number(at);
  const item = {
    id: planItemId({ eventId, kind, at: ms }),
    eventId,
    role: role || null,
    kind,
    channel,
    at: new Date(ms),
    title: title || "Smart Routine",
    body: body || "",
  };
  item.nativeId = numericId(item.id);
  return item;
}

/**
 * @param {object} state           saved app state
 * @param {number} now             wall-clock reference
 * @param {object} [opts]
 * @param {number} [opts.dueWindowMs]  also include items already due within this window
 * @param {number} [opts.cap]          maximum items returned
 * @param {string[]} [opts.channels]   restrict to certain channels
 */
export function buildPlan(state, now = Date.now(), opts = {}) {
  const { dueWindowMs = 0, cap = NATIVE_ALARM_CAP, channels = null } = opts;
  const settings = state?.settings || {};
  const timeZone = resolveTimeZone(settings);
  const leadMin = Math.max(0, settings.alarmLeadMin ?? 10);
  const leadMs = leadMin * 60000;
  const floor = now - Math.max(0, dueWindowMs);
  const byId = new Map();

  const add = (item) => {
    if (item.at.getTime() <= floor) return;
    if (channels && !channels.includes(item.channel)) return;
    if (byId.has(item.id)) return;
    byId.set(item.id, item);
  };

  for (const e of state?.events || []) {
    const channel = classifyEvent(e, settings);
    if (channel === "none") continue;
    const start = new Date(e.start).getTime();
    if (!Number.isFinite(start)) continue;
    const body = eventBody(e, timeZone);

    if (channel === "alarm") {
      add(
        makeItem({
          eventId: e.id,
          role: alarmRole(e),
          kind: "alarm",
          channel: "alarm",
          at: start,
          title: e.title,
          body: `Now · ${body}`,
        })
      );
      continue;
    }

    if (leadMs > 0) {
      add(
        makeItem({
          eventId: e.id,
          kind: "notify",
          channel: "notification",
          at: start - leadMs,
          title: e.title,
          body: `In ${leadMin} min · ${body}`,
        })
      );
    }
    add(
      makeItem({
        eventId: e.id,
        kind: "alarm",
        channel: "notification",
        at: start,
        title: e.title,
        body: `Now · ${body}`,
      })
    );
  }

  for (const w of deriveWakeAlarms(state?.events, settings)) {
    add(
      makeItem({
        eventId: w.eventId,
        role: w.role,
        kind: "wake",
        channel: "alarm",
        at: w.at,
        title: w.title,
        body: w.body,
      })
    );
  }

  const openNotes = (state?.notes || []).filter((n) => !n.converted && String(n.text || "").trim());
  if (openNotes.length) {
    const remindMin = settings.notepadRemindMin ?? 21 * 60 + 30;
    const at = nextNotepadAt(remindMin, now, { floor, timeZone });
    add(
      makeItem({
        eventId: "notepad",
        kind: "notepad",
        channel: "notification",
        at,
        title: "End of day — notepad",
        body: openNotes.map((n) => n.text).slice(0, 4).join(" · "),
      })
    );
  }

  const items = [...byId.values()].sort(
    (a, b) => a.at - b.at || (a.kind === "alarm" ? 1 : -1) || a.id.localeCompare(b.id)
  );
  return cap > 0 ? items.slice(0, cap) : items;
}

/** Items that should fire right now, for the server-side Web Push tick. */
export function dueItems(state, now = Date.now(), windowMs = 45_000) {
  return buildPlan(state, now, { dueWindowMs: windowMs, cap: 0 }).filter((p) => {
    const at = p.at.getTime();
    return at <= now && at > now - windowMs;
  });
}

/**
 * Idempotent sync: what to add, what changed, what to cancel. Because ids embed
 * the fire time, a moved event shows up as one removal plus one addition.
 */
export function diffPlans(prev = [], next = []) {
  const prevById = new Map(prev.map((p) => [p.id, p]));
  const nextById = new Map(next.map((p) => [p.id, p]));
  const add = [];
  const update = [];
  for (const [id, item] of nextById) {
    const old = prevById.get(id);
    if (!old) add.push(item);
    else if (old.title !== item.title || old.body !== item.body) update.push(item);
  }
  const remove = [...prevById.values()].filter((p) => !nextById.has(p.id));
  return { add, update, remove };
}

export function planSummary(plan = []) {
  const alarms = plan.filter((p) => p.channel === "alarm");
  const notifications = plan.filter((p) => p.channel === "notification");
  return {
    total: plan.length,
    alarms: alarms.length,
    notifications: notifications.length,
    nextAlarm: alarms[0] || null,
    nextNotification: notifications[0] || null,
  };
}

/**
 * Which channels the local-notification scheduler owns.
 *
 * Once AlarmKit is driving alarm-channel items they must not also be scheduled
 * as local notifications, or every wake-up and shift start fires twice. On
 * iOS 17-25 the plugin exists but AlarmKit does not, so local notifications
 * remain the fallback for both channels.
 */
export function notificationChannelsFor({ hasAlarmPlugin = false, alarmKitSupported = false } = {}) {
  return hasAlarmPlugin && alarmKitSupported ? ["notification"] : ["notification", "alarm"];
}

/**
 * An installed PWA with a live Web Push subscription already receives every due
 * item from the server, so the in-page timer must stay quiet to avoid a second
 * notification for the same event.
 */
export function shouldTickInPage({ native = false, standalone = false, pushSubscribed = false } = {}) {
  if (native) return false;
  if (standalone && pushSubscribed) return false;
  return true;
}
