import { alarmKitRoute, ALARMKIT_FALLBACK, ALARMKIT_SYNC_KIND, classifyAlarmKitSync, mathVerificationSupported, notificationChannelsForRoute } from "../client/shared/alarm-route.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

assert(alarmKitRoute({}).fallbackReason === ALARMKIT_FALLBACK.NO_PLUGIN, "Missing plugin falls back");
assert(!alarmKitRoute({}).useAlarmKit, "Missing plugin does not use AlarmKit");

assert(
  alarmKitRoute({ hasPlugin: true, supported: false }).fallbackReason === ALARMKIT_FALLBACK.UNSUPPORTED,
  "iOS 17-25 reports requires-ios-26"
);
assert(
  alarmKitRoute({ hasPlugin: true, supported: false, supportReason: "requires-ios-26" }).useAlarmKit === false,
  "Unsupported AlarmKit is not used"
);

const live = {
  hasPlugin: true,
  supported: true,
  authorization: "authorized",
  alarmsEnabled: true,
};
assert(alarmKitRoute(live).useAlarmKit === true, "supported + authorized uses AlarmKit");
assert(alarmKitRoute(live).fallbackReason === null, "Live AlarmKit has no fallback reason");

assert(
  alarmKitRoute({ ...live, authorization: "denied" }).fallbackReason === ALARMKIT_FALLBACK.DENIED,
  "Denied authorization falls back"
);
assert(
  alarmKitRoute({ ...live, authorization: "notDetermined" }).fallbackReason === ALARMKIT_FALLBACK.NOT_DETERMINED,
  "notDetermined falls back — never auto-prompt"
);
assert(
  alarmKitRoute({ ...live, authorization: "unavailable" }).fallbackReason === ALARMKIT_FALLBACK.UNAVAILABLE,
  "unavailable falls back"
);
assert(
  alarmKitRoute({ ...live, authorization: "revoked" }).fallbackReason === ALARMKIT_FALLBACK.REVOKED,
  "revoked keeps a distinct fallback reason"
);
assert(
  notificationChannelsForRoute({ useAlarmKit: true }, { fatal: true }).sort().join() === "alarm,notification",
  "A fatal AlarmKit failure covers the alarm channel locally"
);
assert(
  alarmKitRoute({ ...live, alarmsEnabled: false }).fallbackReason === ALARMKIT_FALLBACK.DISABLED,
  "alarmsEnabled false falls back"
);
assert(
  alarmKitRoute({ ...live, syncFailed: true }).fallbackReason === ALARMKIT_FALLBACK.SYNC_FAILED,
  "Native sync failure falls back"
);
assert(
  alarmKitRoute({ ...live, pluginException: true }).fallbackReason === ALARMKIT_FALLBACK.PLUGIN_EXCEPTION,
  "Plugin exception falls back"
);

assert(
  notificationChannelsForRoute({ useAlarmKit: true }).join() === "notification",
  "Live AlarmKit leaves local notifications with ordinary reminders only"
);
assert(
  notificationChannelsForRoute({ useAlarmKit: false }).sort().join() === "alarm,notification",
  "Fallback local notifications cover both channels"
);

assert(
  classifyAlarmKitSync({
    ok: false,
    scheduled: 1,
    failed: [{ id: "b", error: "..." }],
    capped: [],
  }) === ALARMKIT_SYNC_KIND.PARTIAL,
  "Native-shaped ok:false with a scheduled item is partial"
);
assert(
  classifyAlarmKitSync({
    ok: false,
    scheduled: 1,
    maximumLimitReached: true,
    capped: [{ id: "b", error: "maximumLimitReached" }],
    failed: [],
  }) === ALARMKIT_SYNC_KIND.PARTIAL,
  "maximumLimitReached is partial"
);
assert(
  classifyAlarmKitSync({ ok: false, fatal: true, scheduled: 0, failed: [], capped: [], errors: ["query failed"] }) ===
    ALARMKIT_SYNC_KIND.FATAL,
  "A fatal AlarmManager query is reported separately"
);
assert(classifyAlarmKitSync({ ok: true, scheduled: 2 }) === ALARMKIT_SYNC_KIND.OK, "A clean native sync is ok");
assert(
  classifyAlarmKitSync({ ok: false, scheduled: 0, failed: [], capped: [], errors: ["query failed"] }) ===
    ALARMKIT_SYNC_KIND.FATAL,
  "ok:false with no per-item leftovers is a fatal query failure"
);
assert(mathVerificationSupported("native-ios") === true, "Math verification is native iOS");
assert(mathVerificationSupported("native-android") === false, "Android does not expose math protection");
assert(mathVerificationSupported("pwa") === false, "PWA does not expose math protection");
assert(mathVerificationSupported("browser") === false, "Browser does not expose math protection");

if (failed) {
  console.error(`\n${failed} alarm-route check(s) failed`);
  process.exit(1);
}
console.log("\nAll alarm-route checks passed");
