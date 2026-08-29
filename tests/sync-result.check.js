/**
 * Regression: syncAll() returned ok:true even when scheduleNative() reported
 * ok:false, so diagnostics claimed success while nothing was scheduled.
 *
 * routine-alarms.js is browser code, so the minimum globals are stubbed before
 * it is imported.
 */
let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

const localNotifications = {
  mode: "ok",
  pending: [],
  async getPending() {
    return { notifications: this.pending };
  },
  async schedule({ notifications }) {
    if (this.mode === "throw") throw new Error("simulated schedule failure");
    for (const n of notifications) this.pending.push({ ...n, id: Number(n.id) });
  },
  async cancel({ notifications }) {
    if (this.mode === "cancel-throw") throw new Error("simulated cancel failure");
    const ids = notifications.map((n) => Number(n.id));
    this.pending = this.pending.filter((n) => !ids.includes(Number(n.id)));
  },
  reset(mode = "ok") {
    this.mode = mode;
    this.pending = [];
  },
};

const routineAlarms = {
  supported: true,
  auth: "authorized",
  syncResult: { ok: true, scheduled: 0 },
  syncCalls: [],
  throwOnSync: false,
  throwOnSupported: false,
  pendingChallenge: { active: false },
  async isSupported() {
    if (this.throwOnSupported) throw new Error("plugin exploded");
    return this.supported ? { supported: true } : { supported: false, reason: "requires-ios-26" };
  },
  async getAuthorizationStatus() {
    return { status: this.auth };
  },
  async getScheduledAlarms() {
    return { alarms: [] };
  },
  async getPendingWakeChallenge() {
    return { ...this.pendingChallenge };
  },
  async submitWakeChallenge() {
    return { correct: false, complete: false, attempts: 1 };
  },
  async syncAlarms(payload) {
    this.syncCalls.push(payload);
    if (this.throwOnSync) throw new Error("simulated alarm failure");
    return this.syncResult;
  },
};

globalThis.window = { matchMedia: () => ({ matches: false }), navigator: {} };
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "iPhone; CPU iPhone OS 26_0 like Mac OS X" },
  configurable: true,
  writable: true,
});
globalThis.Capacitor = {
  isNativePlatform: () => true,
  getPlatform: () => "ios",
  Plugins: { LocalNotifications: localNotifications, RoutineAlarms: routineAlarms },
};

const { syncAll, lastError, getDiagnostics } = await import("../client/routine-alarms.js");
const {
  ALARM_HORIZON_DAYS,
  ALARM_PLAN_CAP,
  NATIVE_ALARM_CAP,
  buildAlarmPlan,
  buildPlan,
} = await import("../client/shared/alarm-plan.js");

const now = Date.now();
const at = (h) => new Date(now + h * 3600000).toISOString();
const state = {
  settings: { alarmLeadMin: 10, snoozeMin: 9, timeZone: "Asia/Karachi" },
  events: [
    { id: "s1", title: "Sleep", kind: "sleep", category: "sleep", start: at(-7), end: at(1) },
    { id: "g1", title: "Gym", kind: "gym", category: "gym", start: at(3), end: at(4) },
    { id: "w1", title: "Shift Morning", kind: "work", category: "work", start: at(5), end: at(13) },
  ],
  notes: [],
};

// --- healthy sync ---------------------------------------------------------
localNotifications.reset("ok");
routineAlarms.syncResult = { ok: true, scheduled: 1 };
const good = await syncAll(state, "test-ok");
assert(good.ok === true, "A healthy sync reports ok:true");
assert(good.notifications.ok === true, "Notification leg reports success");
assert(good.alarms.ok === true, "Alarm leg reports success");
assert(good.channels.join() === "notification", "With AlarmKit supported the local scheduler owns notifications only");
assert(routineAlarms.syncCalls.at(-1).alarms.length === 2, "Wake and shift alarms are handed to the plugin");
assert(
  routineAlarms.syncCalls.at(-1).alarms.some((a) => a.role === "wake"),
  "The wake alarm reaches the plugin"
);
assert(
  routineAlarms.syncCalls.at(-1).alarms.some((a) => a.role === "shift"),
  "The shift alarm reaches the plugin"
);
assert(
  localNotifications.pending.every((n) => n.extra.channel === "notification"),
  "No alarm-channel item is scheduled as a local notification"
);

// --- failing notification plugin -----------------------------------------
localNotifications.reset("throw");
const notifyFail = await syncAll(state, "test-notify-fail");
assert(notifyFail.ok === false, "A failing notification plugin makes syncAll report ok:false");
assert(notifyFail.notifications.ok === false, "The notification leg carries the failure");
assert(Boolean(notifyFail.notifications.error), "The notification failure includes an error message");
assert(lastError()?.scope === "syncNotifications", `Last error records the failing scope (got ${lastError()?.scope})`);

// --- failing cancel path --------------------------------------------------
localNotifications.reset("ok");
await syncAll(state, "seed");
localNotifications.pending.push({ id: 999999, title: "stale", body: "", extra: { planId: "gone" } });
localNotifications.mode = "cancel-throw";
const cancelFail = await syncAll(state, "test-cancel-fail");
assert(cancelFail.ok === false, "A failing cancel makes syncAll report ok:false");
assert(cancelFail.notifications.reason === "cancel-failed", `Cancel failure is named (got ${cancelFail.notifications.reason})`);

// --- failing alarm plugin -------------------------------------------------
localNotifications.reset("ok");
routineAlarms.syncResult = { ok: false, error: "AlarmKit denied" };
const alarmFail = await syncAll(state, "test-alarm-fail");
assert(alarmFail.ok === false, "A failing alarm sync makes syncAll report ok:false");
assert(alarmFail.alarms.ok === false, "The alarm leg carries the failure");
assert(lastError()?.scope === "syncAlarms", `Last error records the alarm scope (got ${lastError()?.scope})`);

localNotifications.reset("ok");
routineAlarms.throwOnSync = true;
const alarmThrow = await syncAll(state, "test-alarm-throw");
assert(alarmThrow.ok === false, "A thrown alarm error makes syncAll report ok:false");
assert(Boolean(alarmThrow.alarms.error), "The thrown alarm error is surfaced");
routineAlarms.throwOnSync = false;

// --- both legs failing ----------------------------------------------------
localNotifications.reset("throw");
routineAlarms.syncResult = { ok: false, error: "still denied" };
const bothFail = await syncAll(state, "test-both-fail");
assert(bothFail.ok === false, "Both legs failing reports ok:false");
assert(
  bothFail.notifications.ok === false && bothFail.alarms.ok === false,
  "Both legs report their own failure"
);

// --- iOS 17-25 fallback keeps alarms on local notifications --------------
localNotifications.reset("ok");
routineAlarms.supported = false;
routineAlarms.syncResult = { ok: true };
const fallback = await syncAll(state, "test-fallback");
assert(fallback.channels.sort().join() === "alarm,notification", "Without AlarmKit the local scheduler owns both channels");
assert(
  localNotifications.pending.some((n) => n.extra.channel === "alarm"),
  "Alarm items fall back to local notifications on older iOS"
);
const alarmIds = localNotifications.pending.filter((n) => n.extra.channel === "alarm").map((n) => n.id);
assert(new Set(alarmIds).size === alarmIds.length, "Fallback does not double-schedule alarm items");
routineAlarms.supported = true;

// --- diagnostics reflect the last failure --------------------------------
localNotifications.reset("throw");
routineAlarms.syncResult = { ok: true };
await syncAll(state, "test-diag");
const diag = await getDiagnostics(state);
assert(diag.lastSync.ok === false, "Diagnostics show the failed sync");
assert(diag.lastSync.reason === "test-diag", "Diagnostics name the sync reason");
assert(Boolean(diag.lastError), "Diagnostics expose the last error");
assert(diag.runtimeMode === "native-ios", `Diagnostics report the native runtime (got ${diag.runtimeMode})`);
assert(diag.iosVersion === "26.0", `Diagnostics report the iOS version (got ${diag.iosVersion})`);
assert(diag.deliveryRoute === "native", `Native delivery route is reported (got ${diag.deliveryRoute})`);

// --- a missing plugin is only a failure where one is expected ------------
// In a browser or PWA there is no local-notification plugin, so that leg is
// skipped; on native its absence is a genuine failure.
localNotifications.reset("ok");
routineAlarms.syncResult = { ok: true };
const savedPlugins = globalThis.Capacitor.Plugins;
globalThis.Capacitor.Plugins = { RoutineAlarms: routineAlarms };
const nativeMissing = await syncAll(state, "test-native-missing");
assert(nativeMissing.ok === false, "On native, a missing notification plugin is a failure");
assert(nativeMissing.notifications.reason === "no-plugin", "The missing plugin is named");

const wasNative = globalThis.Capacitor.isNativePlatform;
globalThis.Capacitor.isNativePlatform = () => false;
globalThis.Capacitor.Plugins = {};
const browserSync = await syncAll(state, "test-browser");
assert(browserSync.ok === true, "In a browser, the absent notification plugin is not a failure");
assert(
  browserSync.notifications.skipped === "no-local-notifications",
  `The skipped leg is labelled (got ${browserSync.notifications.skipped})`
);
assert(browserSync.alarms.skipped === "no-alarmkit-plugin", "The alarm leg is skipped in a browser too");
globalThis.Capacitor.isNativePlatform = wasNative;
globalThis.Capacitor.Plugins = savedPlugins;

// --- AlarmKit is not called when it is unsupported ------------------------
// Regression: syncAll checked isSupported() but still called syncAlarms
// whenever the plugin existed, so iOS 17-25 got both AlarmKit and a fallback.
localNotifications.reset("ok");
routineAlarms.supported = false;
routineAlarms.syncResult = { ok: true };
routineAlarms.syncCalls.length = 0;
const unsupported = await syncAll(state, "test-unsupported");
assert(routineAlarms.syncCalls.length === 0, `syncAlarms is not called when unsupported (got ${routineAlarms.syncCalls.length})`);
assert(unsupported.ok === true, "An unsupported AlarmKit is not a failure");
assert(
  unsupported.alarms.skipped === "alarmkit-unsupported",
  `The alarm leg is marked unsupported (got ${unsupported.alarms.skipped})`
);
assert(
  unsupported.channels.sort().join() === "alarm,notification",
  "Alarms fall back to local notifications when AlarmKit is unsupported"
);
assert(
  localNotifications.pending.some((n) => n.extra.channel === "alarm"),
  "The fallback actually schedules the alarm items"
);
routineAlarms.supported = true;

localNotifications.reset("ok");
routineAlarms.syncCalls.length = 0;
const supported = await syncAll(state, "test-supported");
assert(routineAlarms.syncCalls.length === 1, "syncAlarms is called once when supported");
assert(supported.channels.join() === "notification", "Supported AlarmKit owns the alarm channel alone");
assert(
  !localNotifications.pending.some((n) => n.extra.channel === "alarm"),
  "Supported AlarmKit means no alarm-channel local notifications"
);

// --- alarms survive a plan larger than the notification cap --------------
// Regression: the alarm list was built from the capped combined plan, so with
// enough ordinary reminders every alarm silently disappeared.
const h = (n) => new Date(now + n * 3600000).toISOString();
const crowded = {
  settings: { alarmLeadMin: 10, snoozeMin: 9 },
  events: [
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `n${i}`,
      title: `Reminder ${i}`,
      kind: "gym",
      category: "gym",
      start: h(i + 1),
      end: h(i + 2),
    })),
    { id: "shiftLate", title: "Shift Morning", kind: "work", category: "work", start: h(50), end: h(58) },
    { id: "leaveLate", title: "Leave for Office", kind: "leave", category: "commute", start: h(52), end: h(53) },
    { id: "sleepLate", title: "Sleep", kind: "sleep", category: "sleep", start: h(60), end: h(68) },
  ],
  notes: [],
};
assert(buildPlan(crowded).length === NATIVE_ALARM_CAP, "The combined plan is capped at the notification limit");
assert(
  buildPlan(crowded).filter((p) => p.channel === "alarm").length === 0,
  "Filtering the capped plan loses every alarm — the old behaviour"
);

localNotifications.reset("ok");
routineAlarms.syncCalls.length = 0;
await syncAll(crowded, "test-crowded");
const bridged = routineAlarms.syncCalls.at(-1).alarms;
assert(bridged.length === 3, `Every alarm reaches the AlarmKit bridge (got ${bridged.length})`);
assert(
  ["shift", "leave", "wake"].every((role) => bridged.some((a) => a.role === role)),
  `Wake, shift and leave all arrive (got ${bridged.map((a) => a.role).join(",")})`
);
assert(
  bridged.map((a) => a.at).join() === [...bridged].sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).map((a) => a.at).join(),
  "Bridged alarms are ordered soonest first"
);

const alarmOnly = buildAlarmPlan(crowded);
assert(alarmOnly.length === 3, `buildAlarmPlan ignores the notification cap (got ${alarmOnly.length})`);
assert(
  buildAlarmPlan(crowded, now, { horizonDays: 1 }).length === 0,
  "Alarms beyond the horizon are left out"
);
assert(buildAlarmPlan(crowded, now, { cap: 2 }).length === 2, "The alarm cap is applied after channel selection");
assert(ALARM_PLAN_CAP > 0 && ALARM_HORIZON_DAYS > 0, "An AlarmKit cap and horizon are documented");

async function authCase(auth, label) {
  localNotifications.reset("ok");
  routineAlarms.supported = true;
  routineAlarms.auth = auth;
  routineAlarms.syncCalls.length = 0;
  const res = await syncAll(state, `test-auth-${auth}`);
  return { res, calls: routineAlarms.syncCalls.length, pending: localNotifications.pending };
}

{
  const { res, calls, pending } = await authCase("authorized", "authorized");
  assert(calls >= 1, "supported + authorized calls syncAlarms");
  assert(res.channels.join() === "notification", "supported + authorized → AlarmKit owns alarms");
  assert(
    pending.every((n) => n.extra.channel === "notification"),
    "supported + authorized does not duplicate alarms as local notifications"
  );
  assert(res.fallbackReason == null, "Live AlarmKit has no fallback reason");
}

{
  const { res, pending } = await authCase("denied", "denied");
  assert(res.channels.sort().join() === "alarm,notification", "supported + denied → LocalNotifications");
  assert(
    pending.some((n) => n.extra.channel === "alarm"),
    "Denied AlarmKit still schedules wake/shift as local notifications"
  );
  assert(res.fallbackReason === "alarmkit-denied", `Denied fallback reason (got ${res.fallbackReason})`);
  assert(
    routineAlarms.syncCalls.at(-1).alarms.length === 0,
    "Denied AlarmKit syncs an empty list so previously scheduled alarms are cancelled"
  );
}

{
  const { res, pending } = await authCase("notDetermined", "notDetermined");
  assert(res.channels.sort().join() === "alarm,notification", "supported + notDetermined → LocalNotifications");
  assert(
    pending.some((n) => n.extra.channel === "alarm"),
    "notDetermined does not leave the device silent"
  );
  assert(res.fallbackReason === "alarmkit-not-determined", "notDetermined is named in diagnostics");
}

{
  localNotifications.reset("ok");
  routineAlarms.supported = false;
  routineAlarms.auth = "authorized";
  routineAlarms.syncCalls.length = 0;
  const res = await syncAll(state, "test-ios17");
  assert(routineAlarms.syncCalls.length === 0, "iOS 17-25 does not call syncAlarms");
  assert(res.channels.sort().join() === "alarm,notification", "iOS 17-25 → LocalNotifications");
  assert(res.fallbackReason === "requires-ios-26", `iOS 17-25 fallback reason (got ${res.fallbackReason})`);
}

{
  const { res, pending } = await authCase("denied", "revoked-as-denied");
  assert(
    pending.some((n) => n.extra.channel === "alarm"),
    "Revoked/denied authorization keeps local-notification fallback"
  );
}

{
  localNotifications.reset("ok");
  routineAlarms.supported = true;
  routineAlarms.auth = "authorized";
  routineAlarms.throwOnSupported = true;
  routineAlarms.syncCalls.length = 0;
  const res = await syncAll(state, "test-plugin-exception");
  assert(res.ok === true || res.channels.includes("alarm"), "Plugin exception falls back rather than going silent");
  assert(
    localNotifications.pending.some((n) => n.extra.channel === "alarm") || res.fallbackReason === "alarmkit-plugin-exception",
    "A plugin exception uses LocalNotifications"
  );
  routineAlarms.throwOnSupported = false;
}

{
  localNotifications.reset("ok");
  routineAlarms.supported = true;
  routineAlarms.auth = "notDetermined";
  await syncAll(state, "before-auth");
  const before = localNotifications.pending.filter((n) => n.extra.channel === "alarm").map((n) => n.id).sort().join();
  assert(before.length > 0, "Pre-authorization alarms live on local notifications");
  routineAlarms.auth = "authorized";
  routineAlarms.syncResult = { ok: true, scheduled: 2 };
  const after = await syncAll(state, "after-auth");
  assert(after.channels.join() === "notification", "Successful authorization moves items onto AlarmKit");
  assert(
    !localNotifications.pending.some((n) => n.extra.channel === "alarm"),
    "After authorization the same items are not also local notifications"
  );
}

{
  const diag = await getDiagnostics(state);
  assert(!JSON.stringify(diag).includes('"answer"'), "Diagnostics never include a math answer key");
  routineAlarms.pendingChallenge = {
    active: true,
    alarmId: "s1:wake:1",
    question: "17 + 45",
    questionNumber: 1,
    questionCount: 1,
    attempts: 0,
  };
  const withChallenge = await getDiagnostics(state);
  assert(withChallenge.pendingWakeChallenge.active === true, "Pending challenge is visible");
  assert(!JSON.stringify(withChallenge).includes("expected"), "Pending challenge does not expose the expected answer");
  routineAlarms.pendingChallenge = { active: false };
}

if (failed) {
  console.error(`\n${failed} sync-result check(s) failed`);
  process.exit(1);
}
console.log("\nAll sync-result checks passed");
