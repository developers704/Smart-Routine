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
 * disabled alarms, or a failed native sync all fall back to local notifications.
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
