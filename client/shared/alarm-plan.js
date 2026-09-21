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
import { alarmKitRoute } from "./alarm-route.js";

/** iOS keeps at most 64 pending local notifications. */
export const NATIVE_ALARM_CAP = 64;

/**
 * Apple does not publish AlarmKit's per-app alarm limit; `schedule` throws
 * `AlarmManager.AlarmError.maximumLimitReached` when it is exceeded. We stay well
 * inside any plausible limit by scheduling only the alarms inside the app's own
 * two-week planning horizon, soonest first, and the native side still handles
 * that error.
 */
export const ALARM_PLAN_CAP = 32;
export const ALARM_HORIZON_DAYS = 14;

/** One slot is held back so the 2-minute test alarm always fits. */
export const ALARM_TEST_SLOTS = 1;
export const TEST_ALARM_PLAN_ID = "routine-test-alarm";

export const WAKE_VERIFICATION_LIMITS = {
  mathQuestionCount: { min: 1, max: 3 },
  backupAlarmCount: { min: 1, max: 3 },
  backupIntervalMin: { min: 1, max: 5 },
  snoozeMin: { min: 1, max: 60 },
};

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

function clampInt(value, { min, max }, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normalised, always-valid view of the wake-verification settings. */
export function wakeVerificationSettings(settings = {}) {
  const enabled = settings.wakeVerificationEnabled === true;
  const difficulty = DIFFICULTIES.has(settings.mathDifficulty) ? settings.mathDifficulty : "medium";
  return {
    enabled,
    method: "math",
    difficulty,
    questionCount: clampInt(settings.mathQuestionCount, WAKE_VERIFICATION_LIMITS.mathQuestionCount, 1),
    backupCount: clampInt(settings.backupAlarmCount, WAKE_VERIFICATION_LIMITS.backupAlarmCount, 2),
    backupIntervalMin: clampInt(settings.backupIntervalMin, WAKE_VERIFICATION_LIMITS.backupIntervalMin, 1),
    snoozeMin: clampInt(settings.snoozeMin, WAKE_VERIFICATION_LIMITS.snoozeMin, 9),
  };
}

/** `<primary>:backup:<n>` — deterministic, so a resync never duplicates them. */
export function backupAlarmId(primaryId, index) {
  return `${primaryId}:backup:${index}`;
}

export function rearmAlarmId(primaryId) {
  return `${primaryId}:rearm`;
}

export function isBackupAlarmId(id) {
  return /:backup:\d+$/.test(String(id));
}

export function isRearmAlarmId(id) {
  return /:rearm$/.test(String(id));
}

export function primaryIdOfBackup(id) {
  const raw = String(id || "");
  const backup = /^(.*):backup:\d+$/.exec(raw);
  if (backup) return backup[1];
  const rearm = /^(.*):rearm$/.exec(raw);
  return rearm ? rearm[1] : null;
}

export function wakeFamilyIds(primaryId, backupCount = 0) {
  if (!primaryId) return [];
  const ids = [primaryId, rearmAlarmId(primaryId)];
  const n = Math.max(0, Math.round(Number(backupCount)) || 0);
  for (let i = 1; i <= n; i++) ids.push(backupAlarmId(primaryId, i));
  return ids;
}

export function belongsToWakeFamily(id, primaryId) {
  if (!id || !primaryId) return false;
  return id === primaryId || primaryIdOfBackup(id) === primaryId;
}

/** Event id embedded in `eventId:kind:ms` / `eventId:kind:ms:backup:n`. */
export function eventIdFromPlanId(id) {
  const primary = primaryIdOfBackup(id) || String(id || "");
  const cut = primary.indexOf(":");
  if (cut <= 0) return primary || null;
  return primary.slice(0, cut);
}

/**
 * Whether an active math-challenge family should stay protected. Deleted,
 * completed, alarm-off, or disabled wake/master settings must not keep the
 * primary and backups ringing.
 */
export function isTestAlarmFamily(id) {
  const primary = primaryIdOfBackup(id) || String(id || "");
  return primary === TEST_ALARM_PLAN_ID;
}

export function wakeFamilyStillValid(state, primaryId) {
  if (!primaryId) return false;
  const settings = state?.settings || {};
  if (isTestAlarmFamily(primaryId)) {
    return settings.wakeVerificationEnabled === true && settings.alarmsEnabled !== false;
  }
  if (!roleEnabled(ALARM_ROLES.WAKE, settings)) return false;
  const eventId = eventIdFromPlanId(primaryId);
  if (!eventId) return false;
  const ev = (state?.events || []).find((e) => e.id === eventId);
  if (!ev) return false;
  if (ev.done || ev.alarm === false || ev.verifiedAt) return false;
  if (!SLEEP_KINDS.has(ev.kind)) return false;
  return true;
}

export const ALARM_ROLES = {
  WAKE: "wake",
  SHIFT: "shift",
  LEAVE: "leave",
  /** 5 min after commute start — call parents. */
  CALL: "call",
  /** Any other alarm-checked block (meal, study, gym, sleep start, …). */
  EVENT: "event",
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
  if (role === ALARM_ROLES.CALL) return true;
  const key = ROLE_SETTING[role];
  if (!key) return false;
  return settings?.[key] !== false;
}

/** Which alarm role an event maps to, or null when it has no alarm. */
export function alarmRole(event) {
  if (!event) return null;
  if (event.kind === "call-parents") return ALARM_ROLES.CALL;
  if (event.kind === "leave") return ALARM_ROLES.LEAVE;
  if (event.kind === "work" || event.category === "work") return ALARM_ROLES.SHIFT;
  return ALARM_ROLES.EVENT;
}

/** "alarm" | "notification" | "none" */
export function classifyEvent(event, settings = {}) {
  if (!event) return "none";
  if (event.done) return "none";
  if (event.alarm === false) return "none";
  if (!alarmsEnabled(settings)) return "notification";
  const role = alarmRole(event);
  if (role === ALARM_ROLES.SHIFT || role === ALARM_ROLES.LEAVE || role === ALARM_ROLES.CALL) {
    return roleEnabled(role, settings) ? "alarm" : "notification";
  }
  // Gym, MCAT, meals, chores, sleep-start, etc. stay on LocalNotifications.
  // Sleep still gets a separate wake alarm at block end via deriveWakeAlarms.
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
    if (e.verifiedAt) continue;
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
 * @param {string} [opts.protectPrimaryId]  keep this wake family even after it has fired
 * @param {number} [opts.extraBackupCount]  backup count used with protectPrimaryId
 */
export function buildPlan(state, now = Date.now(), opts = {}) {
  const { dueWindowMs = 0, cap = NATIVE_ALARM_CAP, channels = null } = opts;
  const settings = state?.settings || {};
  const timeZone = resolveTimeZone(settings);
  const leadMin = Math.max(0, settings.alarmLeadMin ?? 10);
  const leadMs = leadMin * 60000;
  const floor = now - Math.max(0, dueWindowMs);
  const wv = wakeVerificationSettings(settings);
  const extraBackupCount = opts.extraBackupCount ?? wv.backupCount;
  const family = new Set(wakeFamilyIds(opts.protectPrimaryId, extraBackupCount));
  const byId = new Map();

  const add = (item) => {
    const protectedItem = family.has(item.id);
    if (!protectedItem && item.at.getTime() <= floor) return;
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
          role: alarmRole(e),
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
        role: alarmRole(e),
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

  attachWakeBackups(byId, settings, {
    protectPrimaryId: opts.protectPrimaryId,
    mathProtection: opts.mathProtection,
  });

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
  return cap > 0 ? reserveAlarmSlots(items, cap, opts.protectPrimaryId) : items;
}

/** Items that should fire right now, for the server-side Web Push tick. */
export function dueItems(state, now = Date.now(), windowMs = 45_000) {
  return buildPlan(state, now, { dueWindowMs: windowMs, cap: 0 }).filter((p) => {
    const at = p.at.getTime();
    return at <= now && at > now - windowMs;
  });
}

/**
 * Alarm-channel items only.
 *
 * Building the combined plan and filtering afterwards would apply the
 * 64-notification cap first, so with enough ordinary reminders every alarm fell
 * off the end. This builds the alarm channel on its own with its own cap.
 *
 * Backups are stripped here so the AlarmKit cap can reserve their slots
 * explicitly via `buildAlarmKitItems`.
 */
export function buildAlarmPlan(state, now = Date.now(), opts = {}) {
  const { cap = ALARM_PLAN_CAP, horizonDays = ALARM_HORIZON_DAYS } = opts;
  const horizonMs = now + horizonDays * 24 * 60 * 60 * 1000;
  const items = buildPlan(state, now, {
    channels: ["alarm"],
    cap: 0,
    protectPrimaryId: opts.protectPrimaryId,
    extraBackupCount: opts.extraBackupCount,
    mathProtection: opts.mathProtection,
  }).filter((p) => p.at.getTime() <= horizonMs && !isBackupAlarmId(p.id));
  return cap > 0 ? items.slice(0, cap) : items;
}

function attachWakeBackups(byId, settings, { protectPrimaryId, mathProtection } = {}) {
  const wv = wakeVerificationSettings(settings);
  const mathOn = Boolean(protectPrimaryId) || (mathProtection ?? wv.enabled);
  const backupCount = wv.backupCount;
  const wakes = [...byId.values()]
    .filter((p) => p.role === ALARM_ROLES.WAKE && !isBackupAlarmId(p.id))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  let nearest = wakes[0];
  if (protectPrimaryId) {
    nearest = wakes.find((p) => p.id === protectPrimaryId) || nearest;
  }
  if (!nearest) return;
  for (let i = 1; i <= backupCount; i++) {
    const at = new Date(nearest.at.getTime() + i * wv.backupIntervalMin * 60000);
    const id = backupAlarmId(nearest.id, i);
    if (byId.has(id)) continue;
    const item = {
      id,
      eventId: nearest.eventId,
      role: ALARM_ROLES.WAKE,
      kind: "wake-backup",
      channel: "alarm",
      at,
      title: nearest.title,
      body: `Backup ${i} · ${nearest.body}`,
      backupIndex: i,
      primaryId: nearest.id,
      protected: mathOn,
      snooze: false,
    };
    item.nativeId = numericId(item.id);
    byId.set(id, item);
  }
  nearest.protected = mathOn;
  nearest.snooze = false;
}

/**
 * Combined LocalNotifications cap: nearest wake, its backups, and other
 * alarm-channel items keep their slots. Ordinary reminders fill what remains.
 */
export function reserveAlarmSlots(items, cap, protectPrimaryId = null) {
  if (!(cap > 0) || items.length <= cap) return items;
  const reserved = [];
  const rest = [];
  for (const item of items) {
    if (item.channel === "alarm" || belongsToWakeFamily(item.id, protectPrimaryId)) {
      reserved.push(item);
    } else {
      rest.push(item);
    }
  }
  const out = [];
  for (const item of reserved) {
    if (out.length >= cap) break;
    out.push(item);
  }
  for (const item of rest) {
    if (out.length >= cap) break;
    out.push(item);
  }
  return out;
}

/**
 * AlarmKit payload: primaries plus backups for the single nearest upcoming
 * wake. Backup slots (and the test-alarm slot) are reserved *before* the 32
 * cap is applied. Primaries that do not fit are returned in `capped` so the
 * JS bridge can keep them on LocalNotifications instead of dropping them.
 */
export function buildAlarmKitItems(state, now = Date.now(), opts = {}) {
  const wv = wakeVerificationSettings(state?.settings);
  const testReserved = opts.testAlarmReserved !== false;
  const protectPrimaryId = opts.protectPrimaryId || null;
  const mathProtection = opts.mathProtection ?? wv.enabled;
  const primaries = buildAlarmPlan(state, now, {
    cap: 0,
    horizonDays: opts.horizonDays,
    protectPrimaryId,
    extraBackupCount: opts.extraBackupCount ?? wv.backupCount,
    mathProtection,
  });
  const nearestWake =
    (protectPrimaryId && primaries.find((p) => p.id === protectPrimaryId)) ||
    primaries.find((p) => p.role === ALARM_ROLES.WAKE) ||
    null;
  const mathOn = Boolean(mathProtection || protectPrimaryId);
  const backupSlots = nearestWake ? wv.backupCount : 0;
  const reserved = backupSlots + (testReserved ? ALARM_TEST_SLOTS : 0);
  const primaryBudget = Math.max(0, ALARM_PLAN_CAP - reserved);
  const roleRank = (p) => {
    if (p.role === ALARM_ROLES.WAKE) return 0;
    if (p.role === ALARM_ROLES.SHIFT || p.role === ALARM_ROLES.LEAVE || p.role === ALARM_ROLES.CALL) return 1;
    return 2;
  };
  // Wake / shift / leave keep AlarmKit slots; ordinary events never compete here.
  const schedulablePrimaries = primaries
    .filter((p) => p.at.getTime() > now)
    .sort((a, b) => roleRank(a) - roleRank(b) || a.at - b.at || a.id.localeCompare(b.id));
  const kept = schedulablePrimaries.slice(0, primaryBudget);
  const capped = schedulablePrimaries.slice(primaryBudget);
  const keptWake =
    (nearestWake && (kept.find((p) => p.id === nearestWake.id) || nearestWake)) || null;

  const items = kept.map((p) => {
    const isWake = Boolean(keptWake && p.id === keptWake.id);
    const isProtected = Boolean(isWake && mathOn);
    return {
      id: p.id,
      eventId: p.eventId,
      role: p.role,
      at: p.at,
      title: p.title,
      body: p.body,
      kind: p.kind,
      backupIndex: null,
      primaryId: null,
      protected: isProtected,
      snooze: isWake ? false : true,
    };
  });

  const backups = [];
  if (keptWake) {
    for (let i = 1; i <= wv.backupCount; i++) {
      const at = new Date(keptWake.at.getTime() + i * wv.backupIntervalMin * 60000);
      backups.push({
        id: backupAlarmId(keptWake.id, i),
        eventId: keptWake.eventId,
        role: ALARM_ROLES.WAKE,
        at,
        title: keptWake.title,
        body: `Backup ${i} · ${keptWake.body}`,
        kind: "wake-backup",
        backupIndex: i,
        primaryId: keptWake.id,
        protected: mathOn,
        snooze: false,
      });
    }
  }

  // Wake + backups first so Apple's cap cannot drop follow-up rings
  // after a long list of shift/leave primaries.
  const ordered = [
    ...items.filter((p) => p.id === keptWake?.id),
    ...backups,
    ...items.filter((p) => p.id !== keptWake?.id),
  ].filter((item) => item.at.getTime() > now);

  return {
    items: ordered,
    primaries: items,
    backups,
    capped,
    nearestWake: keptWake,
    reserved,
    primaryBudget,
    verification: wv,
    protectedFamilyIds: protectPrimaryId ? wakeFamilyIds(protectPrimaryId, wv.backupCount) : [],
  };
}

/**
 * Alarm-channel leftovers that LocalNotifications must own: pre-planning
 * overflow plus native failed/capped ids. Successful AlarmKit ids are never
 * included, so they cannot be duplicated.
 */
export function leftoverAlarmIds(nativeAlarms, preCapped = []) {
  const ids = new Set();
  for (const item of preCapped) {
    const id = typeof item === "string" ? item : item?.id;
    if (id) ids.add(id);
  }
  for (const row of nativeAlarms?.capped || []) {
    if (row?.id) ids.add(row.id);
  }
  for (const row of nativeAlarms?.failed || []) {
    if (row?.id) ids.add(row.id);
  }
  return [...ids];
}

export function toAlarmKitPayload(item) {
  return {
    id: item.id,
    eventId: item.eventId,
    role: item.role,
    at: item.at instanceof Date ? item.at.toISOString() : item.at,
    title: item.title,
    body: item.body,
    kind: item.kind || null,
    backupIndex: item.backupIndex,
    primaryId: item.primaryId,
    protected: Boolean(item.protected),
    snooze: item.snooze !== false,
  };
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
export function notificationChannelsFor({
  hasAlarmPlugin = false,
  alarmKitSupported = false,
  alarmKitAuthorized = true,
  alarmsEnabled = true,
} = {}) {
  const route = alarmKitRoute({
    hasPlugin: hasAlarmPlugin,
    supported: alarmKitSupported,
    authorization: alarmKitAuthorized ? "authorized" : "denied",
    alarmsEnabled,
  });
  return route.useAlarmKit ? ["notification"] : ["notification", "alarm"];
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
