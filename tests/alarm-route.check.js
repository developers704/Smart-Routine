import { alarmKitRoute, ALARMKIT_FALLBACK, notificationChannelsForRoute } from "../client/shared/alarm-route.js";

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
  alarmKitRoute({ ...live, authorization: "revoked" }).fallbackReason === ALARMKIT_FALLBACK.DENIED,
  "revoked is treated as denied"
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

if (failed) {
  console.error(`\n${failed} alarm-route check(s) failed`);
  process.exit(1);
}
console.log("\nAll alarm-route checks passed");
