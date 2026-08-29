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
  callOrder: [],
  protectionCalls: [],
  rememberedWake: null,
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
    this.callOrder.push("challenge");
    if (this.pendingChallenge.active) return { ...this.pendingChallenge };
    if (this.rememberedWake?.at && Date.parse(this.rememberedWake.at) <= Date.now()) {
      return {
        active: true,
        alarmId: this.rememberedWake.alarmId,
        question: "3 + 4",
        questionNumber: 1,
        questionCount: this.rememberedWake.questionCount || 1,
        attempts: 0,
      };
    }
    return { active: false };
  },
  async submitWakeChallenge() {
    this.callOrder.push("submit");
    return { correct: false, complete: false, attempts: 1 };
  },
  async syncAlarms(payload) {
    this.callOrder.push("sync");
    this.syncCalls.push(payload);
    if (this.throwOnSync) throw new Error("simulated alarm failure");
    return this.syncResult;
  },
  async cancelWakeProtection(payload) {
    this.callOrder.push("cancel-protect");
    this.protectionCalls.push({ cancel: true, alarmId: payload?.alarmId });
    this.rememberedWake = null;
    this.pendingChallenge = { active: false };
    return { ok: true, alarmId: payload?.alarmId };
  },
  async syncWakeProtection(payload) {
    this.callOrder.push("protect");
    this.protectionCalls.push(payload);
    if (payload.clear) {
      this.rememberedWake = null;
      if (!payload.preserveActive) this.pendingChallenge = { active: false };
      return { ok: true, cleared: true };
    }
    if (payload.preserveActive && this.pendingChallenge.active) {
      return { ok: true, preserved: true, alarmId: this.pendingChallenge.alarmId };
    }
    if (payload.enabled && payload.alarmId) {
      this.rememberedWake = { ...payload };
      return { ok: true, enabled: true, alarmId: payload.alarmId, at: payload.at };
    }
    this.rememberedWake = null;
    return { ok: true, enabled: false };
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

const { syncAll, lastError, getDiagnostics, getPendingWakeChallenge, prepareForegroundSync, submitWakeChallenge } = await import("../client/routine-alarms.js");
const {
  ALARM_HORIZON_DAYS,
  ALARM_PLAN_CAP,
  NATIVE_ALARM_CAP,
  buildAlarmKitItems,
  buildAlarmPlan,
  buildPlan,
  leftoverAlarmIds,
  numericId,
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
assert(alarmFail.fatal === true, "ok:false with no per-item leftovers is fatal");
assert(
  localNotifications.pending.some((n) => n.extra.channel === "alarm"),
  "A fatal alarm sync covers wake/shift locally so the device is not silent"
);
assert(alarmFail.alarmKitUncertain === true, "Fatal uncertainty is reported on the sync result");
assert(alarmFail.fallbackReason === "alarmkit-sync-failed", "Fatal fallback reason is alarmkit-sync-failed");
assert(lastError()?.scope === "syncAlarms", `Last error records the alarm scope (got ${lastError()?.scope})`);

localNotifications.reset("ok");
routineAlarms.throwOnSync = true;
const alarmThrow = await syncAll(state, "test-alarm-throw");
assert(alarmThrow.ok === false, "A thrown alarm error makes syncAll report ok:false");
assert(Boolean(alarmThrow.alarms.error), "The thrown alarm error is surfaced");
assert(alarmThrow.fatal === true, "A thrown syncAlarms is a fatal failure");
assert(
  localNotifications.pending.some((n) => n.extra.channel === "alarm"),
  "A thrown AlarmKit sync covers the alarm channel locally"
);
assert(alarmThrow.alarmKitUncertain === true, "A thrown plugin error reports AlarmKit uncertainty");
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
  buildPlan(crowded).filter((p) => p.channel === "alarm").length === 3,
  "The 64-item cap now reserves alarm-channel items instead of dropping them"
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
  const { res, pending } = await authCase("revoked", "revoked");
  assert(
    pending.some((n) => n.extra.channel === "alarm"),
    "Revoked authorization keeps local-notification fallback"
  );
  assert(res.fallbackReason === "alarmkit-revoked", `revoked fallback reason (got ${res.fallbackReason})`);
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

{
  const floodKit = {
    settings: {
      alarmLeadMin: 10,
      wakeVerificationEnabled: true,
      backupAlarmCount: 2,
      snoozeMin: 9,
    },
    events: [
      { id: "s1", title: "Sleep", kind: "sleep", category: "sleep", start: at(-7), end: at(1) },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `w${i}`,
        title: `Shift ${i}`,
        kind: "work",
        category: "work",
        start: at(i + 2),
        end: at(i + 10),
      })),
    ],
    notes: [],
  };
  const kit = buildAlarmKitItems(floodKit, now);
  assert(kit.capped.length > 0, "Pre-planning produces capped AlarmKit items");
  localNotifications.reset("ok");
  routineAlarms.supported = true;
  routineAlarms.auth = "authorized";
  routineAlarms.syncResult = { ok: true, scheduled: kit.items.length, capped: [], failed: [] };
  routineAlarms.syncCalls.length = 0;
  const res = await syncAll(floodKit, "test-precapped");
  const leftoverIds = leftoverAlarmIds(res.alarms, kit.capped);
  assert(leftoverIds.length === kit.capped.length, "Native-empty capped still keeps pre-planning leftovers");
  const pendingIds = new Set(localNotifications.pending.map((n) => n.extra.planId));
  assert(
    kit.capped.every((item) => pendingIds.has(item.id)),
    "Pre-planning capped items are scheduled as LocalNotifications"
  );
  assert(
    kit.items.every((item) => !pendingIds.has(item.id)),
    "Successful AlarmKit items are not duplicated as LocalNotifications"
  );
}

{
  const sleepEnd = new Date(now - 30_000).toISOString();
  const alerting = {
    settings: {
      alarmLeadMin: 10,
      wakeVerificationEnabled: true,
      backupAlarmCount: 2,
      backupIntervalMin: 1,
      snoozeMin: 9,
    },
    events: [
      {
        id: "s1",
        title: "Sleep",
        kind: "sleep",
        category: "sleep",
        start: new Date(now - 7 * 3600000).toISOString(),
        end: sleepEnd,
      },
      { id: "w1", title: "Shift Morning", kind: "work", category: "work", start: at(5), end: at(13) },
    ],
    notes: [],
  };
  const kitAtSchedule = buildAlarmKitItems(alerting, now - 120_000);
  const primaryId = kitAtSchedule.nearestWake.id;
  const familyIds = [primaryId, `${primaryId}:backup:1`, `${primaryId}:backup:2`];
  const familyNative = familyIds.map((id) => ({
    id: numericId(id),
    title: "Wake up",
    body: "ringing",
    extra: { planId: id, channel: "alarm", kind: "wake" },
  }));

  assert(
    !buildPlan(alerting, now).some((p) => p.id === primaryId),
    "Reproduction: after fire time the unprotected plan drops the alerting wake"
  );

  localNotifications.reset("ok");
  localNotifications.pending = familyNative.map((n) => ({ ...n }));
  routineAlarms.supported = false;
  routineAlarms.auth = "unavailable";
  routineAlarms.pendingChallenge = { active: true, alarmId: primaryId, question: "3 + 4", questionNumber: 1, questionCount: 1, attempts: 0 };
  routineAlarms.syncCalls.length = 0;
  routineAlarms.callOrder = [];
  const startup = await prepareForegroundSync(alerting, "state-loaded");
  assert(routineAlarms.callOrder[0] === "challenge", "Startup reads the pending challenge before any sync");
  assert(startup.protectPrimaryId === primaryId, "Startup protects the alerting primary");
  assert(startup.pending?.active === true, "Startup still returns an active challenge for a valid family");
  const startupPending = new Set(localNotifications.pending.map((n) => n.extra.planId));
  assert(
    familyIds.every((id) => startupPending.has(id)),
    "Opening the app at startup while ringing does not cancel the wake family"
  );

  localNotifications.pending = familyNative.map((n) => ({ ...n }));
  routineAlarms.callOrder = [];
  const active = await prepareForegroundSync(alerting, "app-active");
  assert(routineAlarms.callOrder[0] === "challenge", "appActive reads the pending challenge before any sync");
  assert(active.protectPrimaryId === primaryId, "appActive protects the alerting primary");
  assert(active.pending?.active === true, "appActive still returns an active challenge for a valid family");
  const activePending = new Set(localNotifications.pending.map((n) => n.extra.planId));
  assert(
    familyIds.every((id) => activePending.has(id)),
    "Foregrounding the app while ringing does not cancel the wake family"
  );

  routineAlarms.callOrder = [];
  routineAlarms.syncCalls.length = 0;
  const wrong = await submitWakeChallenge({ alarmId: primaryId, answer: "0" });
  assert(wrong.correct === false, "Wrong answer is not accepted");
  assert(routineAlarms.syncCalls.length === 0, "Wrong answer does not resync or cancel the family");
  assert(
    familyIds.every((id) => localNotifications.pending.some((n) => n.extra.planId === id)),
    "Wrong answer leaves the complete family pending"
  );

  localNotifications.pending = familyNative.map((n) => ({ ...n }));
  routineAlarms.pendingChallenge = { active: false };
  routineAlarms.supported = true;
  routineAlarms.auth = "authorized";
  routineAlarms.syncResult = { ok: true, scheduled: 0, cancelled: 0 };
  const authorizedAlert = await syncAll(alerting, "app-active", { protectPrimaryId: primaryId, now });
  const payload = routineAlarms.syncCalls.at(-1);
  assert(payload.protectPrimaryId === primaryId, "AlarmKit sync receives protectPrimaryId during an alert");
  assert(
    !(payload.alarms || []).some((a) => a.id === primaryId),
    "The alerting primary is not rescheduled as a new AlarmKit item"
  );
  void authorizedAlert;
}

{
  localNotifications.reset("ok");
  routineAlarms.supported = true;
  routineAlarms.auth = "authorized";
  routineAlarms.syncCalls.length = 0;
  routineAlarms.protectionCalls = [];
  const kitItems = buildAlarmKitItems(state, now).items;
  assert(kitItems.length >= 2, "The fixture has at least two AlarmKit items");
  const firstId = kitItems[0].id;
  const secondId = kitItems[1].id;
  routineAlarms.syncResult = {
    ok: false,
    scheduled: 1,
    failed: [{ id: secondId, error: "..." }],
    capped: [],
  };
  const partial = await syncAll(state, "test-partial-fail");
  assert(partial.ok === false, "Partial AlarmKit failure reports ok:false");
  assert(partial.partial === true, "Partial failure is flagged partial");
  assert(partial.fatal !== true, "Partial failure is not fatal");
  const partialPending = new Set(localNotifications.pending.map((n) => n.extra.planId));
  assert(partialPending.has(secondId), "The failed AlarmKit item falls back to LocalNotifications");
  assert(!partialPending.has(firstId), "The successful AlarmKit item is not duplicated as a local notification");
  assert(
    leftoverAlarmIds(partial.alarms, []).join() === secondId,
    "Leftovers are exactly the native failed ids"
  );
}

function coverageState() {
  return {
    settings: { alarmLeadMin: 10, snoozeMin: 9, timeZone: "Asia/Karachi" },
    events: [
      { id: "s1", title: "Sleep", kind: "sleep", category: "sleep", start: at(-7), end: at(1) },
      { id: "w1", title: "Shift Morning", kind: "work", category: "work", start: at(5), end: at(13) },
      { id: "l1", title: "Leave for Office", kind: "leave", category: "commute", start: at(4.5), end: at(5) },
    ],
    notes: [],
  };
}

function alarmEventIds(pending) {
  return new Set(
    pending.filter((n) => n.extra?.channel === "alarm").map((n) => n.extra.eventId)
  );
}

{
  const coverage = coverageState();
  localNotifications.reset("ok");
  routineAlarms.supported = true;
  routineAlarms.auth = "authorized";
  routineAlarms.throwOnSync = false;
  routineAlarms.syncResult = {
    ok: false,
    fatal: true,
    scheduled: 0,
    failed: [],
    capped: [],
    errors: ["query failed"],
  };
  const firstFatal = await syncAll(coverage, "test-fatal-first-sync");
  assert(firstFatal.ok === false, "A first-sync AlarmManager query failure reports ok:false");
  assert(firstFatal.fatal === true, "A query failure is flagged fatal, not partial");
  assert(firstFatal.partial !== true, "A fatal query is not classified as partial");
  assert(firstFatal.alarmKitUncertain === true, "First-sync query failure reports AlarmKit uncertainty");
  assert(firstFatal.alarmCoverage === "local-uncertain", "Fatal coverage is local-uncertain");
  const firstIds = alarmEventIds(localNotifications.pending);
  assert(firstIds.has("s1") && firstIds.has("w1") && firstIds.has("l1"), "First-sync fatal keeps wake/shift/leave on LocalNotifications");
  assert(
    leftoverAlarmIds(firstFatal.alarms, []).length === 0,
    "A fatal query has no per-item leftovers; the whole alarm channel is covered locally"
  );
  const diagFatal = await getDiagnostics(coverage);
  assert(diagFatal.alarmKitUncertain === true, "Diagnostics expose AlarmKit uncertainty after a fatal query");
  assert(diagFatal.fallbackReason === "alarmkit-sync-failed", "Diagnostics name the fatal fallback");
}

{
  const coverage = coverageState();
  localNotifications.reset("ok");
  routineAlarms.supported = true;
  routineAlarms.auth = "authorized";
  routineAlarms.throwOnSync = true;
  const thrown = await syncAll(coverage, "test-fatal-thrown");
  assert(thrown.fatal === true, "A thrown plugin error is fatal");
  const thrownIds = alarmEventIds(localNotifications.pending);
  assert(thrownIds.has("s1") && thrownIds.has("w1") && thrownIds.has("l1"), "Thrown plugin error keeps wake/shift/leave locally scheduled");
  routineAlarms.throwOnSync = false;
}

{
  const coverage = coverageState();
  localNotifications.reset("ok");
  routineAlarms.supported = true;
  routineAlarms.auth = "authorized";
  routineAlarms.syncResult = {
    ok: false,
    fatal: true,
    scheduled: 0,
    failed: [],
    capped: [],
    errors: ["AlarmManager.alarms threw"],
  };
  const seeded = await syncAll(coverage, "seed-before-fatal");
  void seeded;
  const before = alarmEventIds(localNotifications.pending);
  assert(before.has("s1") && before.has("w1") && before.has("l1"), "Fatal native payload schedules wake/shift/leave locally");
  const again = await syncAll(coverage, "test-fatal-native-payload");
  assert(again.fatal === true && again.alarmKitUncertain === true, "Fatal native payload is reported as uncertain local coverage");
  const after = alarmEventIds(localNotifications.pending);
  assert(after.has("s1") && after.has("w1") && after.has("l1"), "A later fatal sync does not cancel existing alarm-channel fallbacks");
  routineAlarms.syncResult = { ok: true, scheduled: 0 };
}

{
  localNotifications.reset("ok");
  routineAlarms.supported = true;
  routineAlarms.auth = "authorized";
  const kitItems = buildAlarmKitItems(state, now).items;
  const firstId = kitItems[0].id;
  const secondId = kitItems[1].id;
  routineAlarms.syncResult = {
    ok: false,
    scheduled: 1,
    failed: [],
    capped: [{ id: secondId, error: "maximumLimitReached" }],
    maximumLimitReached: true,
  };
  const cappedRes = await syncAll(state, "test-partial-cap");
  assert(cappedRes.ok === false, "maximumLimitReached reports ok:false");
  assert(cappedRes.partial === true, "maximumLimitReached is partial, not total");
  const cappedPending = new Set(localNotifications.pending.map((n) => n.extra.planId));
  assert(cappedPending.has(secondId), "Only the capped id falls back to LocalNotifications");
  assert(!cappedPending.has(firstId), "maximumLimitReached does not duplicate the successful AlarmKit alarm");
}

{
  localNotifications.reset("ok");
  routineAlarms.supported = false;
  routineAlarms.auth = "unavailable";
  routineAlarms.protectionCalls = [];
  routineAlarms.rememberedWake = null;
  const wvState = {
    ...state,
    settings: { ...state.settings, wakeVerificationEnabled: true, backupAlarmCount: 2, backupIntervalMin: 1 },
  };
  await syncAll(wvState, "test-ios17-arm");
  const armed = routineAlarms.protectionCalls.at(-1);
  assert(armed?.enabled === true, "iOS 17-25 arms a pending math challenge");
  assert(Boolean(armed.alarmId && armed.at && armed.difficulty), "Fallback protection includes id, date and difficulty");
  assert(
    localNotifications.pending.some((n) => n.extra.kind === "wake-backup"),
    "iOS 17-25 schedules wake backups as local notifications"
  );
}

for (const auth of ["denied", "notDetermined", "revoked"]) {
  localNotifications.reset("ok");
  routineAlarms.supported = true;
  routineAlarms.auth = auth;
  routineAlarms.protectionCalls = [];
  const wvState = {
    ...state,
    settings: { ...state.settings, wakeVerificationEnabled: true, backupAlarmCount: 2 },
  };
  await syncAll(wvState, `test-arm-${auth}`);
  const armed = routineAlarms.protectionCalls.at(-1);
  assert(armed?.enabled === true, `iOS 26 ${auth} arms the fallback math challenge`);
}

{
  localNotifications.reset("ok");
  routineAlarms.supported = false;
  routineAlarms.protectionCalls = [];
  const wvState = {
    ...state,
    settings: { ...state.settings, wakeVerificationEnabled: true, backupAlarmCount: 2, backupIntervalMin: 1 },
  };
  const kit = buildAlarmKitItems(wvState, now, { mathProtection: true });
  const primaryId = kit.nearestWake.id;
  const familyIds = [primaryId, `${primaryId}:backup:1`, `${primaryId}:backup:2`];
  localNotifications.pending = familyIds.map((id) => ({
    id: numericId(id),
    title: "Wake up",
    body: "backup",
    extra: { planId: id, channel: "alarm", kind: "wake" },
  }));
  routineAlarms.pendingChallenge = { active: true, alarmId: primaryId, question: "1+1", questionNumber: 1, questionCount: 1, attempts: 0 };
  const wrong = await submitWakeChallenge({ alarmId: primaryId, answer: "0" });
  assert(wrong.complete !== true, "Wrong fallback answer is not complete");
  assert(
    familyIds.every((id) => localNotifications.pending.some((n) => n.extra.planId === id)),
    "Wrong answer preserves LocalNotifications backups"
  );
  const verified = {
    ...wvState,
    events: wvState.events.map((e) => (e.id === "s1" ? { ...e, verifiedAt: new Date(now).toISOString() } : e)),
  };
  routineAlarms.pendingChallenge = { active: true, alarmId: primaryId, question: "1+1", questionNumber: 1, questionCount: 1, attempts: 0 };
  routineAlarms.protectionCalls = [];
  await syncAll(verified, "wake-verified");
  assert(
    familyIds.every((id) => !localNotifications.pending.some((n) => n.extra.planId === id)),
    "Correct completion cancels fallback primary and backups"
  );
  assert(routineAlarms.pendingChallenge.active !== true, "Correct completion clears the pending challenge");
  assert(
    routineAlarms.protectionCalls.some((p) => p.cancel || p.clear),
    "Correct completion clears challenge as part of cancellation"
  );
}

function seedActiveFamily(alerting, primaryId, familyIds) {
  localNotifications.reset("ok");
  localNotifications.pending = familyIds.map((id) => ({
    id: numericId(id),
    title: "Wake up",
    body: "ringing",
    extra: { planId: id, channel: "alarm", kind: "wake", eventId: "s1" },
  }));
  routineAlarms.pendingChallenge = {
    active: true,
    alarmId: primaryId,
    question: "3 + 4",
    questionNumber: 1,
    questionCount: 1,
    attempts: 0,
  };
  routineAlarms.protectionCalls = [];
  routineAlarms.syncCalls.length = 0;
  routineAlarms.supported = false;
  routineAlarms.auth = "unavailable";
  routineAlarms.syncResult = { ok: true, scheduled: 0 };
}

{
  const sleepEnd = new Date(now - 30_000).toISOString();
  const alerting = {
    settings: {
      alarmLeadMin: 10,
      wakeVerificationEnabled: true,
      backupAlarmCount: 2,
      backupIntervalMin: 1,
      snoozeMin: 9,
    },
    events: [
      {
        id: "s1",
        title: "Sleep",
        kind: "sleep",
        category: "sleep",
        start: new Date(now - 7 * 3600000).toISOString(),
        end: sleepEnd,
      },
      { id: "w1", title: "Shift Morning", kind: "work", category: "work", start: at(5), end: at(13) },
    ],
    notes: [],
  };
  const kitAtSchedule = buildAlarmKitItems(alerting, now - 120_000, { mathProtection: true });
  const primaryId = kitAtSchedule.nearestWake.id;
  const familyIds = [primaryId, `${primaryId}:backup:1`, `${primaryId}:backup:2`];

  seedActiveFamily(alerting, primaryId, familyIds);
  const deleted = { ...alerting, events: alerting.events.filter((e) => e.id !== "s1") };
  const delRes = await prepareForegroundSync(deleted, "event-removed");
  assert(delRes.protectPrimaryId == null, "Deleting the sleep does not keep protectPrimaryId");
  assert(delRes.pending?.active === false, "prepareForegroundSync returns pending.active false after delete");
  assert(
    familyIds.every((id) => !localNotifications.pending.some((n) => n.extra.planId === id)),
    "Deleting the sleep cancels the protected primary and backups"
  );
  assert(routineAlarms.pendingChallenge.active !== true, "Deleting the sleep clears the pending challenge");
  assert(
    routineAlarms.protectionCalls.some((p) => p.cancel || p.clear),
    "Delete clears challenge as part of the cancellation flow"
  );

  seedActiveFamily(alerting, primaryId, familyIds);
  const completed = {
    ...alerting,
    events: alerting.events.map((e) => (e.id === "s1" ? { ...e, done: true } : e)),
  };
  const completedRes = await prepareForegroundSync(completed, "event-completed");
  assert(completedRes.pending?.active === false, "prepareForegroundSync returns pending.active false after complete");
  assert(
    familyIds.every((id) => !localNotifications.pending.some((n) => n.extra.planId === id)),
    "Completing the sleep cancels the protected family"
  );
  assert(routineAlarms.pendingChallenge.active !== true, "Completing the sleep clears the pending challenge");

  seedActiveFamily(alerting, primaryId, familyIds);
  const alarmOff = {
    ...alerting,
    events: alerting.events.map((e) => (e.id === "s1" ? { ...e, alarm: false } : e)),
  };
  const alarmOffRes = await prepareForegroundSync(alarmOff, "alarm-disabled");
  assert(alarmOffRes.pending?.active === false, "prepareForegroundSync returns pending.active false after alarm=false");
  assert(
    familyIds.every((id) => !localNotifications.pending.some((n) => n.extra.planId === id)),
    "alarm=false cancels the protected family"
  );
  assert(routineAlarms.pendingChallenge.active !== true, "alarm=false clears the pending challenge");

  seedActiveFamily(alerting, primaryId, familyIds);
  const wakeOffRes = await prepareForegroundSync(
    { ...alerting, settings: { ...alerting.settings, wakeAlarms: false } },
    "wake-alarms-off"
  );
  assert(wakeOffRes.pending?.active === false, "prepareForegroundSync returns pending.active false after wakeAlarms=false");
  assert(
    familyIds.every((id) => !localNotifications.pending.some((n) => n.extra.planId === id)),
    "wakeAlarms=false cancels the protected family"
  );

  seedActiveFamily(alerting, primaryId, familyIds);
  const masterOffRes = await prepareForegroundSync(
    { ...alerting, settings: { ...alerting.settings, alarmsEnabled: false } },
    "alarms-off"
  );
  assert(masterOffRes.pending?.active === false, "prepareForegroundSync returns pending.active false after alarmsEnabled=false");
  assert(
    familyIds.every((id) => !localNotifications.pending.some((n) => n.extra.planId === id)),
    "alarmsEnabled=false cancels the protected family"
  );

  seedActiveFamily(alerting, primaryId, familyIds);
  const stillWrong = await submitWakeChallenge({ alarmId: primaryId, answer: "0" });
  assert(stillWrong.complete !== true, "Wrong answer during an active family is not complete");
  const validFg = await prepareForegroundSync(alerting, "app-active");
  assert(validFg.pending?.active === true, "A valid active challenge remains pending.active after foreground sync");
  assert(
    familyIds.every((id) => localNotifications.pending.some((n) => n.extra.planId === id)),
    "Foregrounding with a valid active family preserves primary and backups"
  );
  assert(routineAlarms.pendingChallenge.active === true, "A valid active challenge survives foregrounding");

  seedActiveFamily(alerting, primaryId, familyIds);
  routineAlarms.supported = true;
  routineAlarms.auth = "authorized";
  routineAlarms.syncResult = { ok: true, scheduled: 0 };
  const deletedAuth = { ...alerting, events: alerting.events.filter((e) => e.id !== "s1") };
  await syncAll(deletedAuth, "event-removed-alarmkit");
  const lastPayload = routineAlarms.syncCalls.at(-1);
  assert(!lastPayload?.protectPrimaryId, "Deleted wake is not sent as protectPrimaryId to AlarmKit");
  assert(
    familyIds.every((id) => !localNotifications.pending.some((n) => n.extra.planId === id)),
    "Authorized delete still cancels LocalNotifications leftovers"
  );
}

{
  routineAlarms.pendingChallenge = { active: false };
  routineAlarms.rememberedWake = {
    enabled: true,
    alarmId: "s1:wake:1",
    at: new Date(now - 1000).toISOString(),
    difficulty: "medium",
    questionCount: 1,
  };
  const pending = await getPendingWakeChallenge();
  assert(pending.active === true, "Active fallback challenge survives app restart via remembered wake");
  routineAlarms.rememberedWake = null;
}

{
  const prevPlatform = globalThis.Capacitor.getPlatform;
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Linux; Android 14)" },
    configurable: true,
    writable: true,
  });
  globalThis.Capacitor.getPlatform = () => "android";
  localNotifications.reset("ok");
  routineAlarms.protectionCalls = [];
  const wvState = {
    ...state,
    settings: { ...state.settings, wakeVerificationEnabled: true, backupAlarmCount: 2 },
  };
  await syncAll(wvState, "test-android-math");
  assert(routineAlarms.protectionCalls.length === 0, "Android does not call native math protection");
  assert(
    !localNotifications.pending.some((n) => n.extra.kind === "wake-backup"),
    "Android does not schedule verification backup alarms from a stored setting"
  );
  globalThis.Capacitor.getPlatform = prevPlatform;
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "iPhone; CPU iPhone OS 26_0 like Mac OS X" },
    configurable: true,
    writable: true,
  });
}

{
  const prevNative = globalThis.Capacitor.isNativePlatform;
  const prevPlatform = globalThis.Capacitor.getPlatform;
  globalThis.Capacitor.isNativePlatform = () => false;
  globalThis.Capacitor.getPlatform = () => "web";
  localNotifications.reset("ok");
  routineAlarms.protectionCalls = [];
  const wvState = {
    ...state,
    settings: { ...state.settings, wakeVerificationEnabled: true, backupAlarmCount: 2 },
  };
  await syncAll(wvState, "test-pwa-math");
  assert(routineAlarms.protectionCalls.length === 0, "PWA/browser does not call native math protection");
  assert(
    !localNotifications.pending.some((n) => n.extra?.kind === "wake-backup"),
    "PWA/browser does not schedule verification backup alarms from a stored setting"
  );
  globalThis.Capacitor.isNativePlatform = prevNative;
  globalThis.Capacitor.getPlatform = prevPlatform;
}

if (failed) {
  console.error(`\n${failed} sync-result check(s) failed`);
  process.exit(1);
}
console.log("\nAll sync-result checks passed");
