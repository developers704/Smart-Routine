import {
  ALARM_ROLES,
  NATIVE_ALARM_CAP,
  alarmRole,
  buildPlan,
  classifyEvent,
  deriveWakeAlarms,
  diffPlans,
  dueItems,
  numericId,
  planItemId,
  planSummary,
} from "../client/shared/alarm-plan.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

const now = Date.parse("2026-08-24T12:00:00");
const inHours = (h) => new Date(now + h * 3600000).toISOString();

const settings = { alarmLeadMin: 10, notepadRemindMin: 21 * 60 + 30 };

// --- classification -------------------------------------------------------
const wakeSleep = { id: "s1", title: "Sleep", kind: "sleep", category: "sleep", start: inHours(-7), end: inHours(1) };
const shift = { id: "w1", title: "Shift Morning", kind: "work", category: "work", start: inHours(2), end: inHours(10) };
const leave = { id: "l1", title: "Leave for Office", kind: "leave", category: "commute", start: inHours(1.5), end: inHours(2) };
const gym = { id: "g1", title: "Gym", kind: "gym", category: "gym", start: inHours(3), end: inHours(4.5) };
const mcat = { id: "m1", title: "MCAT studying", kind: "mcat", category: "study", start: inHours(5), end: inHours(7) };

assert(alarmRole(shift) === ALARM_ROLES.SHIFT, "Shift blocks classify as shift alarms");
assert(alarmRole(leave) === ALARM_ROLES.LEAVE, "Leave blocks classify as leave alarms");
assert(alarmRole(gym) === null, "Gym is not an alarm role");
assert(classifyEvent(shift, settings) === "alarm", "Shift start uses the alarm channel");
assert(classifyEvent(leave, settings) === "alarm", "Leave time uses the alarm channel");
assert(classifyEvent(gym, settings) === "notification", "Gym uses the notification channel");
assert(classifyEvent(mcat, settings) === "notification", "MCAT uses the notification channel");
assert(classifyEvent({ ...gym, done: true }, settings) === "none", "Completed events are excluded");
assert(classifyEvent({ ...gym, alarm: false }, settings) === "none", "Alarm-off events are excluded");

const wakes = deriveWakeAlarms([wakeSleep, gym], settings);
assert(wakes.length === 1 && wakes[0].role === ALARM_ROLES.WAKE, "Wake alarm derives from the end of sleep");
assert(wakes[0].at === Date.parse(wakeSleep.end), "Wake alarm fires when sleep ends");
assert(
  deriveWakeAlarms([wakeSleep], { ...settings, wakeAlarms: false }).length === 0,
  "Wake alarms respect the wakeAlarms setting"
);
assert(
  deriveWakeAlarms([wakeSleep], { ...settings, alarmsEnabled: false }).length === 0,
  "Master alarm switch disables wake alarms"
);
assert(
  classifyEvent(shift, { ...settings, shiftAlarms: false }) === "notification",
  "Disabling shift alarms downgrades to a notification"
);
assert(
  classifyEvent(leave, { ...settings, alarmsEnabled: false }) === "notification",
  "Master switch downgrades leave alarms to notifications"
);

// --- plan shape -----------------------------------------------------------
const state = { settings, events: [wakeSleep, shift, leave, gym, mcat], notes: [] };
const plan = buildPlan(state, now);

const gymItems = plan.filter((p) => p.eventId === "g1");
assert(gymItems.length === 2, `Notification events get lead + on-time (got ${gymItems.length})`);
assert(gymItems.every((p) => p.channel === "notification"), "Gym items stay on the notification channel");

const shiftItems = plan.filter((p) => p.eventId === "w1");
assert(shiftItems.length === 1, `Alarm events get a single alarm (got ${shiftItems.length})`);
assert(shiftItems[0].channel === "alarm", "Shift item is on the alarm channel");
assert(shiftItems[0].at.getTime() === Date.parse(shift.start), "Shift alarm fires at shift start");

const wakeItems = plan.filter((p) => p.kind === "wake");
assert(wakeItems.length === 1 && wakeItems[0].channel === "alarm", "Wake alarm appears on the alarm channel");

// --- identifiers ----------------------------------------------------------
assert(
  planItemId({ eventId: "g1", kind: "alarm", at: Date.parse(gym.start) }) ===
    planItemId({ eventId: "g1", kind: "alarm", at: new Date(gym.start) }),
  "Item ids are stable across Date and epoch inputs"
);
const rebuilt = buildPlan(state, now);
assert(
  rebuilt.map((p) => p.id).join() === plan.map((p) => p.id).join(),
  "Rebuilding the same state yields identical ids"
);
assert(
  rebuilt.map((p) => p.nativeId).join() === plan.map((p) => p.nativeId).join(),
  "Native numeric ids are stable across rebuilds"
);
assert(new Set(plan.map((p) => p.nativeId)).size === plan.length, "Native ids are unique within a plan");
assert(numericId("a") !== numericId("b"), "Different ids hash differently");
assert(numericId("x") > 0 && Number.isInteger(numericId("x")), "Native id is a positive integer");

const duplicated = buildPlan({ ...state, events: [...state.events, { ...gym }] }, now);
assert(
  duplicated.filter((p) => p.eventId === "g1").length === 2,
  "Duplicate event objects collapse to one set of items"
);

// --- reschedule / cancel --------------------------------------------------
const moved = { ...gym, start: inHours(6), end: inHours(7.5) };
const movedPlan = buildPlan({ ...state, events: [wakeSleep, shift, leave, moved, mcat] }, now);
const movedDiff = diffPlans(plan, movedPlan);
assert(
  movedDiff.remove.filter((p) => p.eventId === "g1").length === 2 &&
    movedDiff.add.filter((p) => p.eventId === "g1").length === 2,
  "Moving an event cancels the old items and adds new ones"
);

const retitled = buildPlan({ ...state, events: [wakeSleep, shift, leave, { ...gym, title: "Gym session" }, mcat] }, now);
const titleDiff = diffPlans(plan, retitled);
assert(
  titleDiff.update.length === 2 && titleDiff.add.length === 0 && titleDiff.remove.length === 0,
  "Retitling updates the existing items in place"
);

const deletedPlan = buildPlan({ ...state, events: [wakeSleep, shift, leave, mcat] }, now);
const deletedDiff = diffPlans(plan, deletedPlan);
assert(
  deletedDiff.remove.length === 2 && deletedDiff.remove.every((p) => p.eventId === "g1"),
  "Deleting an event cancels exactly its items"
);

const completedPlan = buildPlan({ ...state, events: [wakeSleep, shift, leave, { ...gym, done: true }, mcat] }, now);
assert(
  completedPlan.every((p) => p.eventId !== "g1"),
  "Completing an event removes it from the plan"
);
const completedDiff = diffPlans(plan, completedPlan);
assert(completedDiff.remove.length === 2 && completedDiff.add.length === 0, "Completion produces cancellations only");

const noSyncNeeded = diffPlans(plan, buildPlan(state, now));
assert(
  noSyncNeeded.add.length === 0 && noSyncNeeded.remove.length === 0 && noSyncNeeded.update.length === 0,
  "Re-syncing unchanged state is a no-op"
);

// --- due items (Web Push timing) -----------------------------------------
const dueState = {
  settings,
  events: [{ id: "d1", title: "Due now", kind: "gym", category: "gym", start: new Date(now).toISOString(), end: inHours(1) }],
  notes: [],
};
const due = dueItems(dueState, now, 45_000);
assert(due.length === 1, `An event starting now is due (got ${due.length})`);
assert(due[0].at.getTime() === now, "Due item fires at the event start");
assert(dueItems(dueState, now + 30_000, 45_000).length === 1, "Still due 30s after the fire time");
assert(dueItems(dueState, now + 60_000, 45_000).length === 0, "No longer due past the window");
assert(dueItems(dueState, now - 60_000, 45_000).length === 0, "Not due before the fire time");
assert(buildPlan(dueState, now).every((p) => p.at.getTime() > now), "Default plan only contains future items");

// --- notepad + cap --------------------------------------------------------
const withNotes = buildPlan({ ...state, notes: [{ text: "buy oats", converted: false }] }, now);
assert(withNotes.some((p) => p.kind === "notepad"), "Open notes get an end-of-day reminder");

const flood = {
  settings,
  events: Array.from({ length: 80 }, (_, i) => ({
    id: `e${i}`,
    title: `E${i}`,
    kind: "gym",
    category: "gym",
    start: inHours(i + 2),
    end: inHours(i + 3),
    alarm: true,
  })),
  notes: [],
};
const capped = buildPlan(flood, now);
assert(capped.length === NATIVE_ALARM_CAP, `iOS pending cap ${NATIVE_ALARM_CAP} (got ${capped.length})`);
assert(capped[0].at <= capped[capped.length - 1].at, "Soonest fires are scheduled first");

const summary = planSummary(plan);
assert(summary.alarms === 3, `Summary counts alarms (got ${summary.alarms})`);
assert(summary.notifications === plan.length - 3, "Summary counts notifications");
assert(summary.nextAlarm !== null && summary.nextNotification !== null, "Summary exposes next alarm and notification");

if (failed) {
  console.error(`\n${failed} alarm-plan check(s) failed`);
  process.exit(1);
}
console.log("\nAll alarm-plan checks passed");
