/**
 * One entry point for every scheduling path, so callers never branch on runtime.
 *
 * Priority: AlarmKit plugin (iOS 26+, authorized) → Capacitor local notifications
 * (iOS 17-25 / denied / notDetermined / sync failure / Android) → Web Push
 * (installed PWA) → in-page timer.
 *
 * Every call returns a structured result; nothing is swallowed. AlarmKit and
 * local notifications never both own the same item.
 */
import { isNative, plugin } from "./native.js";
import {
  buildAlarmKitItems,
  buildPlan,
  leftoverAlarmIds,
  numericId,
  planSummary,
  primaryIdOfBackup,
  shouldTickInPage,
  toAlarmKitPayload,
  wakeFamilyStillValid,
  wakeVerificationSettings,
} from "./shared/alarm-plan.js";
import { alarmKitRoute, classifyAlarmKitSync, ALARMKIT_FALLBACK, ALARMKIT_SYNC_KIND, mathVerificationSupported, notificationChannelsForRoute } from "./shared/alarm-route.js";
import { payloadExposesAnswer, publicChallengeView } from "./shared/math-challenge.js";
import {
  getPendingNative,
  cancelNativeIds,
  ensurePermission,
  scheduleNative,
  setInPageTicking,
} from "./alarms.js";
import { isStandalonePwa, pushStatus, setupWebPush, subscriptionEndpoint } from "./push.js";

const TEST_NOTIFICATION_ID = numericId("routine-test-notification");
const TEST_ALARM_ID = "routine-test-alarm";

const diag = {
  lastSync: null,
  lastSyncReason: null,
  lastError: null,
  gate: null,
  fallbackReason: null,
  lastNativeError: null,
  maximumLimit: null,
};

function alarmPlugin() {
  return plugin("RoutineAlarms");
}

function iosVersion() {
  const m = /(?:iPhone )?OS (\d+)[._](\d+)/.exec(navigator.userAgent || "");
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), text: `${m[1]}.${m[2]}` };
}

export function runtimeMode() {
  if (!isNative()) return isStandalonePwa() ? "pwa" : "browser";
  const platform = globalThis.Capacitor?.getPlatform?.();
  if (platform === "ios") return "native-ios";
  if (platform === "android") return "native-android";
  return "native";
}

export function isNativeIos() {
  return runtimeMode() === "native-ios";
}

export { mathVerificationSupported };

export function notificationPermission() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

function recordError(scope, err) {
  diag.lastError = { scope, message: String(err?.message || err), at: new Date().toISOString() };
  if (scope === "syncAlarms" || scope === "alarmSupport" || scope === "alarmAuthorization") {
    diag.lastNativeError = diag.lastError;
  }
  return diag.lastError;
}

function stripSecrets(value) {
  if (payloadExposesAnswer(value)) {
    throw new Error("wake-challenge payload exposed an expected answer");
  }
  return value;
}

/** Must be called from a user tap — iOS ignores permission prompts otherwise. */
export async function enableNotifications() {
  try {
    const api = await ensurePermission({ interactive: true });
    if (api) {
      const perms = await api.checkPermissions?.().catch(() => null);
      const granted = !perms || perms.display === "granted";
      if (!granted) return { ok: false, reason: "denied", detail: "Allow notifications in iPhone Settings → Smart Routine." };
      return { ok: true, path: "local-notifications" };
    }
    if (notificationPermission() === "unsupported") {
      return { ok: false, reason: "unsupported", detail: "This browser cannot show notifications." };
    }
    if (notificationPermission() !== "granted") {
      return { ok: false, reason: "denied", detail: "Notifications were not allowed." };
    }
    if (!isStandalonePwa()) {
      return {
        ok: false,
        reason: "not-standalone",
        detail: "Add Smart Routine to your Home Screen and open it from that icon, then enable again.",
      };
    }
    const push = await setupWebPush();
    return push.ok
      ? { ok: true, path: "web-push" }
      : { ok: false, reason: push.reason, detail: webPushHint(push.reason) };
  } catch (err) {
    recordError("enableNotifications", err);
    return { ok: false, reason: "error", detail: String(err?.message || err) };
  }
}

function webPushHint(reason) {
  if (reason === "no-vapid" || reason === "no-server") {
    return "Server push keys are not configured yet, so background reminders are off.";
  }
  if (reason === "save-failed") return "The server rejected this device’s subscription.";
  return "Background reminders could not be enabled.";
}

/** AlarmKit authorization — native only, from a user tap. Never called at startup. */
export async function enableAlarms() {
  const api = alarmPlugin();
  if (!api) {
    return {
      ok: false,
      reason: "unavailable",
      detail: "iPhone alarms need the native Smart Routine app build.",
    };
  }
  try {
    const res = await api.requestAuthorization();
    if (res?.status === "authorized") return { ok: true, status: res.status };
    return {
      ok: false,
      reason: res?.status || "denied",
      detail: "Allow alarms in iPhone Settings → Smart Routine → Alarms.",
    };
  } catch (err) {
    recordError("enableAlarms", err);
    return { ok: false, reason: "error", detail: String(err?.message || err) };
  }
}

async function readAlarmSupport(api) {
  try {
    return (await api.isSupported()) || { supported: false };
  } catch (err) {
    recordError("alarmSupport", err);
    return { supported: false, reason: "plugin-exception", error: String(err?.message || err) };
  }
}

async function readAlarmAuthorization(api) {
  try {
    const res = await api.getAuthorizationStatus();
    return res?.status || "unavailable";
  } catch (err) {
    recordError("alarmAuthorization", err);
    return "unavailable";
  }
}

/**
 * Reschedules everything from current state. Idempotent — safe after any change.
 * @param {object} state
 * @param {string} reason  why we synced, surfaced in diagnostics
 * @param {object} [opts]
 * @param {string} [opts.protectPrimaryId]  do not cancel/reschedule this wake family
 * @param {number} [opts.now]
 */
export async function syncAll(state, reason = "manual", opts = {}) {
  const result = {
    reason,
    at: new Date().toISOString(),
    notifications: null,
    alarms: null,
    ok: true,
    fallbackReason: null,
    channels: ["notification", "alarm"],
    partial: false,
    fatal: false,
  };
  const now = opts.now ?? Date.now();
  const api = alarmPlugin();
  const alarmsEnabled = state?.settings?.alarmsEnabled !== false;
  const nativeIos = isNativeIos();
  let support = { supported: false };
  let authorization = "unavailable";
  let pluginException = false;
  let protectPrimaryId = opts.protectPrimaryId || null;

  if (api) {
    support = await readAlarmSupport(api);
    if (support.reason === "plugin-exception") pluginException = true;
    authorization = await readAlarmAuthorization(api);
  }

  let route = alarmKitRoute({
    hasPlugin: Boolean(api),
    supported: Boolean(support.supported),
    supportReason: support.reason || null,
    authorization,
    alarmsEnabled,
    pluginException,
  });

  if (!protectPrimaryId && nativeIos && api?.getPendingWakeChallenge) {
    const pending = await getPendingWakeChallenge();
    if (pending?.active) {
      protectPrimaryId = primaryIdOfBackup(pending.alarmId) || pending.alarmId;
    }
  }

  let releasePrimaryId = null;
  if (protectPrimaryId && !wakeFamilyStillValid(state, protectPrimaryId)) {
    releasePrimaryId = protectPrimaryId;
    protectPrimaryId = null;
  }

  if (releasePrimaryId && api) {
    try {
      if (api.cancelWakeProtection) {
        result.wakeProtection = await api.cancelWakeProtection({ alarmId: releasePrimaryId });
      } else if (api.syncWakeProtection) {
        result.wakeProtection = await api.syncWakeProtection({
          enabled: false,
          clear: true,
          alarmId: releasePrimaryId,
        });
      }
      if (result.wakeProtection?.ok === false) result.ok = false;
    } catch (err) {
      result.ok = false;
      result.wakeProtection = { ok: false, error: recordError("cancelWakeProtection", err).message };
    }
  }

  const wakeVerification = wakeVerificationSettings(state?.settings);
  const mathProtection = nativeIos && wakeVerification.enabled;
  const kit = buildAlarmKitItems(state, now, {
    protectPrimaryId,
    extraBackupCount: wakeVerification.backupCount,
    mathProtection,
  });

  const shouldTalkToPlugin = Boolean(api) && (route.useAlarmKit || Boolean(support.supported));
  if (shouldTalkToPlugin) {
    try {
      result.alarms = await api.syncAlarms({
        alarms: route.useAlarmKit ? kit.items.map(toAlarmKitPayload) : [],
        snoozeMin: wakeVerification.snoozeMin,
        wakeVerification: route.useAlarmKit ? wakeVerification : { ...wakeVerification, enabled: false },
        protectPrimaryId,
        extraBackupCount: wakeVerification.backupCount,
      });
      if (result.alarms?.ok === false) {
        const kind = classifyAlarmKitSync(result.alarms);
        result.alarms.kind = kind;
        result.ok = false;
        if (kind === ALARMKIT_SYNC_KIND.PARTIAL) {
          result.partial = true;
          result.alarms.partial = true;
          result.alarms.fatal = false;
          recordError("syncAlarms", result.alarms.error || "syncAlarms reported a partial failure");
        } else {
          result.fatal = true;
          result.alarms.fatal = true;
          result.alarms.partial = false;
          recordError("syncAlarms", result.alarms.error || "syncAlarms reported failure");
        }
      }
      if (result.alarms?.maximumLimitReached || (result.alarms?.capped || []).length) {
        diag.maximumLimit = {
          at: result.at,
          capped: (result.alarms.capped || []).length,
          errors: result.alarms.errors || [],
        };
      }
    } catch (err) {
      result.ok = false;
      result.fatal = true;
      result.alarms = {
        ok: false,
        fatal: true,
        partial: false,
        kind: ALARMKIT_SYNC_KIND.FATAL,
        error: recordError("syncAlarms", err).message,
      };
    }
  } else if (api && !pluginException && support.supported === false) {
    result.alarms = { ok: true, skipped: "alarmkit-unsupported", reason: support.reason || route.fallbackReason };
  } else if (api && !route.useAlarmKit) {
    result.alarms = { ok: true, skipped: route.fallbackReason, reason: route.fallbackReason };
  } else {
    result.alarms = { ok: true, skipped: "no-alarmkit-plugin" };
  }

  const alarmKind = classifyAlarmKitSync(result.alarms);
  const isFatal = result.fatal || alarmKind === ALARMKIT_SYNC_KIND.FATAL;
  const alarmKitOwnsSuccesses = route.useAlarmKit && !isFatal;
  const leftovers = alarmKitOwnsSuccesses ? leftoverAlarmIds(result.alarms, kit.capped) : [];
  result.channels = notificationChannelsForRoute(route, { leftoverAlarmIds: leftovers, fatal: isFatal });
  result.fallbackReason = route.useAlarmKit && !leftovers.length && !isFatal ? null : route.fallbackReason;
  if (leftovers.length && route.useAlarmKit && !isFatal) {
    result.fallbackReason = result.fallbackReason || (result.alarms?.maximumLimitReached ? "alarmkit-capped" : ALARMKIT_FALLBACK.PARTIAL);
  }
  if (isFatal) {
    result.fatal = true;
    result.alarmKitUncertain = true;
    result.alarmCoverage = "local-uncertain";
    result.fallbackReason = result.fallbackReason || ALARMKIT_FALLBACK.SYNC_FAILED;
  } else if (leftovers.length && route.useAlarmKit) {
    result.alarmCoverage = "partial-local";
    result.alarmKitUncertain = false;
  } else {
    result.alarmCoverage = route.useAlarmKit ? "alarmkit" : "local";
    result.alarmKitUncertain = false;
  }
  diag.fallbackReason = result.fallbackReason;

  try {
    const localApi = plugin("LocalNotifications");
    if (!localApi && !isNative()) {
      result.notifications = { ok: true, skipped: "no-local-notifications" };
    } else {
      result.notifications = await scheduleNative(state, localApi, {
        channels: result.channels,
        leftoverAlarmIds: leftovers,
        alarmKitOwnsAlarms: alarmKitOwnsSuccesses && leftovers.length === 0,
        protectPrimaryId,
        extraBackupCount: wakeVerification.backupCount,
        mathProtection,
        now,
      });
      if (result.notifications?.ok === false) {
        result.ok = false;
        recordError("syncNotifications", result.notifications.error || result.notifications.reason || "scheduleNative failed");
      }
    }
  } catch (err) {
    result.ok = false;
    result.notifications = { ok: false, error: recordError("syncNotifications", err).message };
  }

  result.wakeProtection = await syncFallbackWakeProtection(state, {
    now,
    protectPrimaryId,
    mathProtection,
    kit,
    wv: wakeVerification,
    alreadyReleased: Boolean(releasePrimaryId),
  });
  if (result.wakeProtection?.ok === false) result.ok = false;

  await refreshTickGate();
  diag.lastSync = result;
  diag.lastSyncReason = reason;
  return result;
}

function isoOf(at) {
  if (!at) return null;
  return at instanceof Date ? at.toISOString() : new Date(at).toISOString();
}

function wakeFamilyStillPlanned(state, primaryId, now, mathProtection) {
  if (!primaryId || !wakeFamilyStillValid(state, primaryId)) return false;
  const plan = buildPlan(state, now, { cap: 0, mathProtection, protectPrimaryId: primaryId });
  return plan.some((p) => p.id === primaryId || p.primaryId === primaryId);
}

async function syncFallbackWakeProtection(state, { now, protectPrimaryId, mathProtection, kit, wv, alreadyReleased }) {
  if (!isNativeIos()) return { skipped: "not-ios" };
  const api = alarmPlugin();
  if (!api?.syncWakeProtection) return { skipped: "unavailable" };
  try {
    const activeId = protectPrimaryId || null;
    if (alreadyReleased) {
      // Session and AlarmKit family were already released. Arm the next wake
      // if math is still on; do not re-protect the cancelled family.
    } else if (activeId && !wakeFamilyStillValid(state, activeId)) {
      if (api.cancelWakeProtection) {
        return await api.cancelWakeProtection({ alarmId: activeId });
      }
      return await api.syncWakeProtection({ enabled: false, clear: true, alarmId: activeId });
    }
    if (activeId) {
      const planned = buildPlan(state, now, { cap: 0, mathProtection: true, protectPrimaryId: activeId });
      const item = planned.find((p) => p.id === activeId);
      return await api.syncWakeProtection({
        enabled: true,
        preserveActive: true,
        alarmId: activeId,
        at: isoOf(item?.at) || isoOf(kit.nearestWake?.at),
        difficulty: wv.difficulty,
        questionCount: wv.questionCount,
      });
    }
    if (!mathProtection) {
      return await api.syncWakeProtection({ enabled: false, clear: true });
    }
    const nearest = kit.nearestWake;
    if (!nearest) {
      return await api.syncWakeProtection({ enabled: false, clear: true });
    }
    return await api.syncWakeProtection({
      enabled: true,
      alarmId: nearest.id,
      at: isoOf(nearest.at),
      difficulty: wv.difficulty,
      questionCount: wv.questionCount,
    });
  } catch (err) {
    recordError("syncWakeProtection", err);
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Startup and appActive must read the pending challenge *before* any sync.
 * After the protected wake time has passed, buildPlan would otherwise drop
 * the family and syncAll would cancel the alerting alarm as stale.
 */
export async function prepareForegroundSync(state, reason = "foreground") {
  const pending = await getPendingWakeChallenge();
  const alarmId = pending?.active ? pending.alarmId : null;
  const rawId = alarmId ? primaryIdOfBackup(alarmId) || alarmId : null;
  const protectPrimaryId = rawId && wakeFamilyStillValid(state, rawId) ? rawId : null;
  const result = await syncAll(state, reason, { protectPrimaryId: rawId || null });
  return { pending, protectPrimaryId, result };
}

/**
 * Decides whether the in-page timer should run.
 *
 * A local PushManager subscription is not proof the server knows about it: the
 * POST can fail, or the server can lose its subscription file. Silencing the
 * page on local state alone would leave the device with no reminders at all, so
 * the gate needs the server to confirm this endpoint is registered, and tries
 * one re-registration before giving up.
 */
export async function refreshTickGate() {
  const native = isNative();
  const standalone = isStandalonePwa();
  let pushSubscribed = false;
  let detail = null;

  if (!native && standalone) {
    const endpoint = await subscriptionEndpoint();
    if (!endpoint) {
      detail = "no-local-subscription";
    } else {
      let registered = await verifyServerRegistration(endpoint);
      if (!registered) {
        const retry = await setupWebPush();
        registered = retry.ok && (await verifyServerRegistration(endpoint));
        detail = registered ? "re-registered" : "server-registration-missing";
      }
      pushSubscribed = registered;
    }
  }

  const tick = shouldTickInPage({ native, standalone, pushSubscribed });
  setInPageTicking(tick);
  const gate = { tick, native, standalone, pushSubscribed, detail };
  diag.gate = gate;
  return gate;
}

async function verifyServerRegistration(endpoint) {
  try {
    const res = await fetch("/api/push/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return Boolean(body.registered);
  } catch (err) {
    recordError("verifyPushRegistration", err);
    return false;
  }
}

export async function scheduleTestNotification(minutes = 2) {
  const at = new Date(Date.now() + minutes * 60000);
  const api = plugin("LocalNotifications");
  if (api) {
    try {
      await api.schedule({
        notifications: [
          {
            id: TEST_NOTIFICATION_ID,
            title: "Smart Routine test",
            body: `Scheduled ${minutes} minutes ago. Notifications work.`,
            schedule: { at, allowWhileIdle: true },
            sound: "default",
          },
        ],
      });
      return { ok: true, path: "local-notifications", at: at.toISOString() };
    } catch (err) {
      return { ok: false, reason: "error", detail: recordError("testNotification", err).message };
    }
  }
  try {
    const endpoint = await subscriptionEndpoint();
    if (!endpoint) {
      return {
        ok: false,
        reason: "not-subscribed",
        detail: "This device has no push subscription yet — enable notifications first.",
      };
    }
    const res = await fetch("/api/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes, endpoint }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      return { ok: false, reason: body.error || "server-error", detail: "Server could not schedule the test push." };
    }
    return { ok: true, path: "web-push", at: body.at };
  } catch (err) {
    return { ok: false, reason: "offline", detail: recordError("testNotification", err).message };
  }
}

export async function cancelTestNotification() {
  const api = plugin("LocalNotifications");
  if (api) {
    const ok = await cancelNativeIds([TEST_NOTIFICATION_ID]);
    return { ok, path: "local-notifications" };
  }
  try {
    const endpoint = await subscriptionEndpoint();
    if (!endpoint) return { ok: false, reason: "not-subscribed" };
    const res = await fetch("/api/push/test", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return { ok: res.ok, path: "web-push" };
  } catch (err) {
    return { ok: false, detail: recordError("cancelTestNotification", err).message };
  }
}

export async function scheduleTestAlarm(minutes = 2) {
  const api = alarmPlugin();
  if (!api) {
    return { ok: false, reason: "unavailable", detail: "Test alarms need the native app build." };
  }
  try {
    const at = new Date(Date.now() + minutes * 60000);
    const res = await api.scheduleTestAlarm({ id: TEST_ALARM_ID, at: at.toISOString(), minutes });
    return res?.ok === false
      ? { ok: false, reason: res.reason || "error", detail: res.error }
      : { ok: true, at: at.toISOString(), path: "alarmkit" };
  } catch (err) {
    return { ok: false, reason: "error", detail: recordError("testAlarm", err).message };
  }
}

export async function cancelTestAlarm() {
  const api = alarmPlugin();
  if (!api) return { ok: false, reason: "unavailable" };
  try {
    const res = await api.cancelTestAlarm({ id: TEST_ALARM_ID });
    return res?.ok === false ? { ok: false, reason: res.reason || "error", detail: res.error } : { ok: true };
  } catch (err) {
    return { ok: false, detail: recordError("cancelTestAlarm", err).message };
  }
}

export async function getPendingWakeChallenge() {
  const api = alarmPlugin();
  if (!api?.getPendingWakeChallenge) return { active: false };
  try {
    const res = await api.getPendingWakeChallenge();
    return stripSecrets(res && typeof res === "object" ? res : { active: false });
  } catch (err) {
    recordError("getPendingWakeChallenge", err);
    return { active: false, ok: false, reason: "error", detail: String(err?.message || err) };
  }
}

export async function submitWakeChallenge({ alarmId, answer } = {}) {
  const api = alarmPlugin();
  if (!api?.submitWakeChallenge) {
    return { ok: false, correct: false, complete: false, reason: "unavailable" };
  }
  try {
    const res = await api.submitWakeChallenge({ alarmId, answer });
    return stripSecrets(res && typeof res === "object" ? res : { correct: false, complete: false });
  } catch (err) {
    recordError("submitWakeChallenge", err);
    return { ok: false, correct: false, complete: false, reason: "error", detail: String(err?.message || err) };
  }
}

export async function cancelWakeProtection({ alarmId } = {}) {
  const api = alarmPlugin();
  if (!api?.cancelWakeProtection) return { ok: false, reason: "unavailable" };
  try {
    const res = await api.cancelWakeProtection({ alarmId });
    return res && typeof res === "object" ? res : { ok: false };
  } catch (err) {
    recordError("cancelWakeProtection", err);
    return { ok: false, reason: "error", detail: String(err?.message || err) };
  }
}

function splitScheduled(alarms = []) {
  const list = Array.isArray(alarms) ? alarms : [];
  const backups = list.filter((a) => /:backup:\d+$/.test(String(a.id || a.planId || "")));
  const primaries = list.filter((a) => !/:backup:\d+$/.test(String(a.id || a.planId || "")));
  return { primaries, backups };
}

export async function getDiagnostics(state) {
  const mode = runtimeMode();
  const nativeIos = mode === "native-ios";
  const ios = iosVersion();
  const api = alarmPlugin();
  const wv = wakeVerificationSettings(state?.settings);
  const mathProtection = nativeIos && wv.enabled;
  const plan = buildPlan(state, Date.now(), { mathProtection });
  const summary = planSummary(plan);
  const kit = buildAlarmKitItems(state, Date.now(), { mathProtection });

  let alarmSupportInfo = { supported: false, reason: mode.startsWith("native") ? "plugin-missing" : "not-native" };
  let alarmAuth = "unavailable";
  let scheduledAlarms = [];
  let pendingChallenge = { active: false };
  if (api) {
    try {
      alarmSupportInfo = (await api.isSupported()) || alarmSupportInfo;
      alarmAuth = (await api.getAuthorizationStatus())?.status || "unknown";
      scheduledAlarms = (await api.getScheduledAlarms())?.alarms || [];
      pendingChallenge = stripSecrets((await getPendingWakeChallenge()) || { active: false });
    } catch (err) {
      recordError("diagnostics", err);
    }
  }

  const { primaries, backups } = splitScheduled(scheduledAlarms);
  const pending = await getPendingNative();
  const push = mode === "native-ios" || mode === "native-android" ? { supported: false } : await pushStatus();
  const gate = await refreshTickGate();
  const route = alarmKitRoute({
    hasPlugin: Boolean(api),
    supported: Boolean(alarmSupportInfo.supported),
    supportReason: alarmSupportInfo.reason || null,
    authorization: alarmAuth,
    alarmsEnabled: state?.settings?.alarmsEnabled !== false,
  });

  const challengePublic = pendingChallenge.active
    ? publicChallengeView({
        alarmId: pendingChallenge.alarmId,
        questions: [{ question: pendingChallenge.question }],
        questionIndex: Math.max(0, (pendingChallenge.questionNumber || 1) - 1),
        questionCount: pendingChallenge.questionCount || 1,
        attempts: pendingChallenge.attempts || 0,
        complete: false,
      })
    : { active: false };

  return stripSecrets({
    runtimeMode: mode,
    iosVersion: ios?.text || "n/a",
    alarmKitSupported: Boolean(alarmSupportInfo.supported),
    alarmKitReason: alarmSupportInfo.reason || null,
    alarmAuthorization: alarmAuth,
    notificationAuthorization: notificationPermission(),
    screenTimeAuthorization: "unavailable",
    scheduledAlarms: scheduledAlarms.length,
    scheduledPrimaryAlarms: primaries.length,
    backupAlarmCount: backups.length,
    pendingWakeChallenge: challengePublic.active
      ? {
          active: true,
          alarmId: challengePublic.alarmId,
          questionNumber: challengePublic.questionNumber,
          questionCount: challengePublic.questionCount,
          attempts: challengePublic.attempts,
        }
      : { active: false },
    nextProtectedWake: kit.nearestWake
      ? { id: kit.nearestWake.id, title: kit.nearestWake.title, at: kit.nearestWake.at.toISOString() }
      : null,
    pendingNotifications: pending.length,
    plannedAlarms: summary.alarms,
    plannedNotifications: summary.notifications,
    deliveryRoute: gate.tick ? "in-page timer" : gate.native ? "native" : "server Web Push",
    deliveryDetail: gate.detail,
    fallbackReason: diag.fallbackReason || route.fallbackReason,
    alarmKitUncertain: Boolean(diag.lastSync?.alarmKitUncertain || diag.lastSync?.fatal),
    alarmCoverage: diag.lastSync?.alarmCoverage || (route.useAlarmKit ? "alarmkit" : "local"),
    maximumLimit: diag.maximumLimit,
    timeZone: state?.settings?.timeZone || "system",
    nextAlarm: summary.nextAlarm
      ? { title: summary.nextAlarm.title, at: summary.nextAlarm.at.toISOString() }
      : null,
    nextNotification: summary.nextNotification
      ? { title: summary.nextNotification.title, at: summary.nextNotification.at.toISOString() }
      : null,
    wakeVerification: {
      enabled: nativeIos && wv.enabled,
      stored: wv.enabled,
      method: wv.method,
      difficulty: wv.difficulty,
      questionCount: wv.questionCount,
      backupCount: wv.backupCount,
      backupIntervalMin: wv.backupIntervalMin,
      nativeIos,
    },
    webPush: push,
    lastSync: diag.lastSync,
    lastError: diag.lastError,
    lastNativeError: diag.lastNativeError,
  });
}

export function lastError() {
  return diag.lastError;
}

export function lastFallbackReason() {
  return diag.fallbackReason;
}

export { TEST_ALARM_ID };
