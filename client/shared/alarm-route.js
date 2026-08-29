/**
 * Decides whether AlarmKit owns the alarm channel or LocalNotifications must
 * keep covering wake/shift/leave so the device is never silent.
 *
 * AlarmKit is active only when all of these are true:
 *   - the RoutineAlarms plugin exists
 *   - the device reports AlarmKit support (iOS 26+)
 *   - authorization is `authorized`
 *   - settings.alarmsEnabled is not false
 *
 * Denied, notDetermined, revoked, unavailable, unsupported, missing plugin,
 * or disabled alarms fall back to local notifications. A *fatal* AlarmKit
 * sync (cannot query AlarmManager) is reported separately and must not dump
 * successful-but-unknown AlarmKit items onto LocalNotifications. A *partial*
 * sync (per-item failure or maximumLimitReached) keeps AlarmKit ownership of
 * successes and leftovers only the failed/capped ids.
 * The same item is never scheduled on both channels.
 */

export const ALARMKIT_FALLBACK = {
  NO_PLUGIN: "no-alarmkit-plugin",
  UNSUPPORTED: "requires-ios-26",
  DISABLED: "alarms-disabled",
  DENIED: "alarmkit-denied",
  NOT_DETERMINED: "alarmkit-not-determined",
  UNAVAILABLE: "alarmkit-unavailable",
  REVOKED: "alarmkit-revoked",
  UNAUTHORIZED: "alarmkit-unauthorized",
  SYNC_FAILED: "alarmkit-sync-failed",
  PLUGIN_EXCEPTION: "alarmkit-plugin-exception",
  PARTIAL: "alarmkit-partial",
};

export const ALARMKIT_SYNC_KIND = {
  OK: "ok",
  PARTIAL: "partial",
  FATAL: "fatal",
};

export function normalizeAuthorization(status) {
  const s = String(status || "").trim();
  if (s === "authorized" || s === "denied" || s === "notDetermined" || s === "unavailable") return s;
  if (s === "revoked") return "denied";
  if (!s || s === "unknown") return "unavailable";
  return s;
}

/**
 * @param {object} opts
 * @param {boolean} [opts.hasPlugin]
 * @param {boolean} [opts.supported]
 * @param {string}  [opts.supportReason]
 * @param {string}  [opts.authorization]
 * @param {boolean} [opts.alarmsEnabled]
 * @param {boolean} [opts.syncFailed]
 * @param {boolean} [opts.pluginException]
 */
export function alarmKitRoute(opts = {}) {
  const {
    hasPlugin = false,
    supported = false,
    supportReason = null,
    authorization = "unavailable",
    alarmsEnabled = true,
    syncFailed = false,
    pluginException = false,
  } = opts;

  if (!hasPlugin) {
    return { useAlarmKit: false, fallbackReason: ALARMKIT_FALLBACK.NO_PLUGIN };
  }
  if (pluginException) {
    return { useAlarmKit: false, fallbackReason: ALARMKIT_FALLBACK.PLUGIN_EXCEPTION };
  }
  if (!supported) {
    return {
      useAlarmKit: false,
      fallbackReason: supportReason || ALARMKIT_FALLBACK.UNSUPPORTED,
    };
  }
  if (alarmsEnabled === false) {
    return { useAlarmKit: false, fallbackReason: ALARMKIT_FALLBACK.DISABLED };
  }

  const auth = normalizeAuthorization(authorization);
  if (auth === "denied") {
    return { useAlarmKit: false, fallbackReason: ALARMKIT_FALLBACK.DENIED };
  }
  if (auth === "notDetermined") {
    return { useAlarmKit: false, fallbackReason: ALARMKIT_FALLBACK.NOT_DETERMINED };
  }
  if (auth === "unavailable") {
    return { useAlarmKit: false, fallbackReason: ALARMKIT_FALLBACK.UNAVAILABLE };
  }
  if (auth === "revoked") {
    return { useAlarmKit: false, fallbackReason: ALARMKIT_FALLBACK.REVOKED };
  }
  if (auth !== "authorized") {
    return { useAlarmKit: false, fallbackReason: ALARMKIT_FALLBACK.UNAUTHORIZED };
  }
  if (syncFailed) {
    return { useAlarmKit: false, fallbackReason: ALARMKIT_FALLBACK.SYNC_FAILED };
  }

  return { useAlarmKit: true, fallbackReason: null };
}

/**
 * Native AlarmKit sync results:
 *   ok      — every requested item scheduled or unchanged
 *   partial — some items scheduled; failed/capped/maximumLimitReached for the rest
 *   fatal   — could not read AlarmManager state (or equivalent total failure)
 *
 * Partial must not flip the whole route onto LocalNotifications, or successful
 * AlarmKit alarms are duplicated.
 */
export function classifyAlarmKitSync(native) {
  if (!native || typeof native !== "object") return ALARMKIT_SYNC_KIND.FATAL;
  if (native.fatal === true) return ALARMKIT_SYNC_KIND.FATAL;
  if (native.partial === true) return ALARMKIT_SYNC_KIND.PARTIAL;
  if (native.ok !== false) return ALARMKIT_SYNC_KIND.OK;
  if (native.maximumLimitReached) return ALARMKIT_SYNC_KIND.PARTIAL;
  const failed = Array.isArray(native.failed) ? native.failed.length : 0;
  const capped = Array.isArray(native.capped) ? native.capped.length : 0;
  const scheduled = Number(native.scheduled) || 0;
  const unchanged = Number(native.unchanged) || 0;
  const updated = Number(native.updated) || 0;
  if (failed || capped || scheduled || unchanged || updated) return ALARMKIT_SYNC_KIND.PARTIAL;
  return ALARMKIT_SYNC_KIND.FATAL;
}

/**
 * Math Wake Verification UI and backup generation are native iOS only.
 * Android, browser and PWA must not claim or schedule that protection.
 */
export function mathVerificationSupported(runtimeMode) {
  return runtimeMode === "native-ios";
}

/**
 * Local-notification scheduler ownership. When AlarmKit is live it must not
 * also receive alarm-channel items (that would double-fire). When AlarmKit is
 * not live, local notifications cover both channels.
 *
 * `alarmItems` can list ids that failed or were capped on AlarmKit so those
 * specific items still fall back without duplicating successful AlarmKit ones.
 */
export function notificationChannelsForRoute(route, { leftoverAlarmIds } = {}) {
  if (route?.useAlarmKit && !(leftoverAlarmIds && leftoverAlarmIds.length)) {
    return ["notification"];
  }
  return ["notification", "alarm"];
}
