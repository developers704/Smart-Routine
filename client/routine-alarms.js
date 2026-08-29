/**
 * One entry point for every scheduling path, so callers never branch on runtime.
 *
 * Priority: AlarmKit plugin (iOS 26+) → Capacitor local notifications
 * (iOS 17-25 / Android) → Web Push (installed PWA) → in-page timer.
 *
 * Every call returns a structured result; nothing is swallowed.
 */
import { isNative, plugin } from "./native.js";
import {
  buildAlarmPlan,
  buildPlan,
  notificationChannelsFor,
  numericId,
  planSummary,
  shouldTickInPage,
} from "./shared/alarm-plan.js";
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

export function notificationPermission() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

function recordError(scope, err) {
  diag.lastError = { scope, message: String(err?.message || err), at: new Date().toISOString() };
  return diag.lastError;
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

/** AlarmKit authorization — native only, from a user tap. */
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

/**
 * Reschedules everything from current state. Idempotent — safe after any change.
 * @param {object} state
 * @param {string} reason  why we synced, surfaced in diagnostics
 */
export async function syncAll(state, reason = "manual") {
  const result = { reason, at: new Date().toISOString(), notifications: null, alarms: null, ok: true };
  const api = alarmPlugin();
  const support = api ? await alarmSupport(api) : { supported: false };

  // With AlarmKit live, alarm-channel items belong to it alone.
  const channels = notificationChannelsFor({
    hasAlarmPlugin: Boolean(api),
    alarmKitSupported: Boolean(support.supported),
  });

  try {
    const localApi = plugin("LocalNotifications");
    if (!localApi && !isNative()) {
      // A browser or PWA has no local-notification plugin; delivery is Web Push
      // or the in-page timer, so this leg is skipped rather than failed.
      result.notifications = { ok: true, skipped: "no-local-notifications" };
      result.channels = channels;
    } else {
      result.notifications = await scheduleNative(state, localApi, { channels });
      result.channels = channels;
      if (result.notifications?.ok === false) {
        result.ok = false;
        recordError("syncNotifications", result.notifications.error || result.notifications.reason || "scheduleNative failed");
      }
    }
  } catch (err) {
    result.ok = false;
    result.notifications = { ok: false, error: recordError("syncNotifications", err).message };
  }

  if (api && support.supported) {
    try {
      const plan = buildAlarmPlan(state);
      result.alarms = await api.syncAlarms({
        alarms: plan.map((p) => ({
          id: p.id,
          eventId: p.eventId,
          role: p.role,
          at: p.at.toISOString(),
          title: p.title,
          body: p.body,
        })),
        snoozeMin: state?.settings?.snoozeMin ?? 9,
      });
      if (result.alarms?.ok === false) {
        result.ok = false;
        recordError("syncAlarms", result.alarms.error || "syncAlarms reported failure");
      }
    } catch (err) {
      result.ok = false;
      result.alarms = { ok: false, error: recordError("syncAlarms", err).message };
    }
  } else if (api) {
    // Plugin present but AlarmKit unavailable (iOS 17-25): alarms travel as
    // local notifications instead, so calling syncAlarms would double-schedule.
    result.alarms = { ok: true, skipped: "alarmkit-unsupported", reason: support.reason || null };
  } else {
    result.alarms = { ok: true, skipped: "no-alarmkit-plugin" };
  }

  await refreshTickGate();
  diag.lastSync = result;
  diag.lastSyncReason = reason;
  return result;
}

async function alarmSupport(api) {
  try {
    return (await api.isSupported()) || { supported: false };
  } catch (err) {
    recordError("alarmSupport", err);
    return { supported: false };
  }
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
      : { ok: true, at: at.toISOString() };
  } catch (err) {
    return { ok: false, reason: "error", detail: recordError("testAlarm", err).message };
  }
}

export async function cancelTestAlarm() {
  const api = alarmPlugin();
  if (!api) return { ok: false, reason: "unavailable" };
  try {
    await api.cancelTestAlarm({ id: TEST_ALARM_ID });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: recordError("cancelTestAlarm", err).message };
  }
}

export async function getDiagnostics(state) {
  const mode = runtimeMode();
  const ios = iosVersion();
  const api = alarmPlugin();
  const plan = buildPlan(state);
  const summary = planSummary(plan);

  let alarmSupportInfo = { supported: false, reason: mode.startsWith("native") ? "plugin-missing" : "not-native" };
  let alarmAuth = "unavailable";
  let scheduledAlarms = [];
  if (api) {
    try {
      alarmSupportInfo = (await api.isSupported()) || alarmSupportInfo;
      alarmAuth = (await api.getAuthorizationStatus())?.status || "unknown";
      scheduledAlarms = (await api.getScheduledAlarms())?.alarms || [];
    } catch (err) {
      recordError("diagnostics", err);
    }
  }

  const pending = await getPendingNative();
  const push = mode === "native-ios" || mode === "native-android" ? { supported: false } : await pushStatus();
  const gate = await refreshTickGate();

  return {
    runtimeMode: mode,
    iosVersion: ios?.text || "n/a",
    alarmKitSupported: Boolean(alarmSupportInfo.supported),
    alarmKitReason: alarmSupportInfo.reason || null,
    alarmAuthorization: alarmAuth,
    notificationAuthorization: notificationPermission(),
    screenTimeAuthorization: "unavailable",
    scheduledAlarms: scheduledAlarms.length,
    pendingNotifications: pending.length,
    plannedAlarms: summary.alarms,
    plannedNotifications: summary.notifications,
    deliveryRoute: gate.tick ? "in-page timer" : gate.native ? "native" : "server Web Push",
    deliveryDetail: gate.detail,
    timeZone: state?.settings?.timeZone || "system",
    nextAlarm: summary.nextAlarm
      ? { title: summary.nextAlarm.title, at: summary.nextAlarm.at.toISOString() }
      : null,
    nextNotification: summary.nextNotification
      ? { title: summary.nextNotification.title, at: summary.nextNotification.at.toISOString() }
      : null,
    webPush: push,
    lastSync: diag.lastSync,
    lastError: diag.lastError,
  };
}

export function lastError() {
  return diag.lastError;
}
