import {
  ALARM_ROLES,
  NATIVE_ALARM_CAP,
  alarmRole,
  buildPlan,
  classifyEvent,
  deriveWakeAlarms,
  diffPlans,
  dueItems,
  leftoverAlarmIds,
  nextNotepadAt,
  notificationChannelsFor,
  numericId,
  planItemId,
  planSummary,
  shouldTickInPage,
} from "../client/shared/alarm-plan.js";
import { clockLabel, epochForZonedTime, resolveTimeZone, systemTimeZone } from "../client/shared/tz.js";

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
assert(
  deriveWakeAlarms([{ ...wakeSleep, verifiedAt: "2026-08-24T13:00:00.000Z" }], settings).length === 0,
  "A verified sleep block does not produce another wake alarm"
);

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

const mixedFlood = {
  settings,
  events: [
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `n${i}`,
      title: `Reminder ${i}`,
      kind: "gym",
      category: "gym",
      start: inHours(i + 1),
      end: inHours(i + 2),
    })),
    { id: "shiftLate", title: "Shift Morning", kind: "work", category: "work", start: inHours(50), end: inHours(58) },
    { id: "leaveLate", title: "Leave for Office", kind: "leave", category: "commute", start: inHours(52), end: inHours(53) },
    { id: "sleepLate", title: "Sleep", kind: "sleep", category: "sleep", start: inHours(60), end: inHours(68) },
  ],
  notes: [],
};
const reservedPlan = buildPlan(mixedFlood, now);
assert(reservedPlan.length === NATIVE_ALARM_CAP, "Mixed flood still respects the 64-item cap");
const reservedAlarms = reservedPlan.filter((p) => p.channel === "alarm");
assert(
  reservedAlarms.length === 3,
  `The 64-item cap reserves wake/shift/leave before reminders (got ${reservedAlarms.length})`
);
assert(
  ["wake", "shift", "leave"].every((role) => reservedAlarms.some((p) => p.role === role || p.kind === role)),
  "Nearest wake, shift, and leave keep their slots"
);
assert(
  reservedPlan.filter((p) => p.channel === "notification").length === NATIVE_ALARM_CAP - 3,
  "Ordinary reminders fill only the remaining slots"
);

const leftover = leftoverAlarmIds(
  { capped: [{ id: "native-capped" }], failed: [{ id: "native-failed" }] },
  [{ id: "pre-capped" }, { id: "native-capped" }]
);
assert(
  leftover.sort().join() === ["native-capped", "native-failed", "pre-capped"].sort().join(),
  "Leftover union combines pre-planning capped with native failed/capped and de-dupes"
);
assert(!leftover.includes("ok-id"), "Successful AlarmKit ids are not leftovers");
assert(
  leftoverAlarmIds(
    { ok: false, scheduled: 1, failed: [{ id: "second" }], capped: [] },
    []
  ).join() === "second",
  "An ok:false partial native result leftover is only the failed id"
);

const summary = planSummary(plan);
assert(summary.alarms === 3, `Summary counts alarms (got ${summary.alarms})`);
assert(summary.notifications === plan.length - 3, "Summary counts notifications");
assert(summary.nextAlarm !== null && summary.nextNotification !== null, "Summary exposes next alarm and notification");

// --- notepad due window ---------------------------------------------------
// Regression: the reminder rolled to tomorrow the moment its time passed, so a
// tick even a second late produced no notepad item at all.
const tz = "America/New_York";
const remindMin = 21 * 60 + 30;
const notepadState = { settings: { ...settings, notepadRemindMin: remindMin, timeZone: tz }, events: [], notes: [{ text: "buy oats", converted: false }] };
const at2130 = epochForZonedTime(tz, { year: 2026, month: 8, day: 24, hour: 21, minute: 30 });

const before = nextNotepadAt(remindMin, at2130 - 60_000, { floor: at2130 - 60_000 - 45_000, timeZone: tz });
assert(before.getTime() === at2130, "Before the reminder time, today's 21:30 is planned");

const exact = dueItems(notepadState, at2130, 45_000).filter((p) => p.kind === "notepad");
assert(exact.length === 1, `At exactly 21:30 the notepad item is due (got ${exact.length})`);

const late = dueItems(notepadState, at2130 + 30_000, 45_000).filter((p) => p.kind === "notepad");
assert(late.length === 1, `30 seconds late the notepad item is still due (got ${late.length})`);

const tooLate = dueItems(notepadState, at2130 + 120_000, 45_000).filter((p) => p.kind === "notepad");
assert(tooLate.length === 0, "Two minutes late the notepad item is no longer due");

const tomorrow = nextNotepadAt(remindMin, at2130 + 120_000, { floor: at2130 + 120_000 - 45_000, timeZone: tz });
assert(
  tomorrow.getTime() === epochForZonedTime(tz, { year: 2026, month: 8, day: 25, hour: 21, minute: 30 }),
  "Past the window the reminder moves to tomorrow's 21:30"
);

const planned = buildPlan(notepadState, at2130 - 60_000).filter((p) => p.kind === "notepad");
assert(planned.length === 1 && planned[0].at.getTime() === at2130, "Ordinary planning still schedules today's reminder");

// --- explicit time zone ---------------------------------------------------
// The VPS runs UTC; 21:30 must mean 21:30 where the user is.
const karachi = "Asia/Karachi";
const nyAt = nextNotepadAt(remindMin, at2130 - 3600_000, { floor: at2130 - 3600_000, timeZone: tz });
const pkAt = nextNotepadAt(remindMin, at2130 - 3600_000, { floor: at2130 - 3600_000, timeZone: karachi });
assert(nyAt.getTime() !== pkAt.getTime(), "The same reminder resolves to different instants per zone");
assert(clockLabel(nyAt.getTime(), tz) === "21:30", "New York reminder lands on 21:30 local");
assert(clockLabel(pkAt.getTime(), karachi) === "21:30", "Karachi reminder lands on 21:30 local");

const labelState = {
  settings: { ...settings, timeZone: karachi },
  events: [{ id: "tzev", title: "Gym", kind: "gym", category: "gym", start: at2130, end: at2130 + 3600_000 }],
  notes: [],
};
const tzItem = buildPlan(labelState, at2130 - 3600_000).find((p) => p.kind === "alarm");
assert(
  tzItem.body.includes(clockLabel(at2130, karachi)),
  `Clock labels use the user's zone, not the host's (got "${tzItem.body}")`
);
assert(
  !tzItem.body.includes(clockLabel(at2130, "UTC")) || karachi === "UTC",
  "Clock label is not the UTC host time"
);
assert(resolveTimeZone({ timeZone: "Not/AZone" }) === systemTimeZone(), "An invalid zone falls back to the host zone");
assert(resolveTimeZone({ timeZone: karachi }) === karachi, "A valid zone setting is honoured");

// DST boundary: US spring-forward day still resolves a real instant.
const dstDay = nextNotepadAt(remindMin, epochForZonedTime(tz, { year: 2027, month: 3, day: 14, hour: 12, minute: 0 }), {
  floor: 0,
  timeZone: tz,
});
assert(clockLabel(dstDay.getTime(), tz) === "21:30", "Reminder still lands on 21:30 across a DST transition");

// --- channel ownership ----------------------------------------------------
assert(
  notificationChannelsFor({ hasAlarmPlugin: true, alarmKitSupported: true }).join() === "notification",
  "With AlarmKit live, local notifications only own ordinary reminders"
);
assert(
  notificationChannelsFor({ hasAlarmPlugin: true, alarmKitSupported: false }).sort().join() === "alarm,notification",
  "On iOS 17-25 local notifications cover alarms too"
);
assert(
  notificationChannelsFor({}).sort().join() === "alarm,notification",
  "In the PWA local notifications cover both channels"
);
const notifyOnly = buildPlan(state, now, { channels: ["notification"] });
assert(notifyOnly.every((p) => p.channel === "notification"), "Channel filter excludes alarm items");
assert(notifyOnly.length === plan.length - 3, "Channel filter keeps every ordinary item");

// --- in-page ticking gate -------------------------------------------------
assert(shouldTickInPage({ native: true }) === false, "Native never ticks in-page");
assert(
  shouldTickInPage({ standalone: true, pushSubscribed: true }) === false,
  "An installed PWA with Web Push does not also tick in-page"
);
assert(
  shouldTickInPage({ standalone: true, pushSubscribed: false }) === true,
  "An installed PWA without Web Push falls back to in-page ticking"
);
assert(shouldTickInPage({ standalone: false, pushSubscribed: true }) === true, "A plain browser tab keeps ticking");

if (failed) {
  console.error(`\n${failed} alarm-plan check(s) failed`);
  process.exit(1);
}
console.log("\nAll alarm-plan checks passed");
