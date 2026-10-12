import { planRange } from "../client/shared/scheduler.js";
import { schoolLeaveLead, trafficFromRoute } from "../client/shared/school-leave.js";
import { buildPlan } from "../client/shared/alarm-plan.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

const monday = "2026-08-24";
const events = planRange({
  shifts: { [monday]: "M" },
  userEvents: [],
  from: monday,
  to: monday,
});
assert(events.length === 0, "Shift codes no longer build a hospital day");

const klass = {
  id: "c1",
  title: "Biology",
  kind: "class",
  source: "user",
  date: monday,
  start: "2026-08-24T08:00:00",
  end: "2026-08-24T08:50:00",
  alarm: true,
};
const kept = planRange({
  userEvents: [klass],
  from: monday,
  to: monday,
});
assert(kept.length === 1 && kept[0].kind === "class", "A class the user added stays on the day");

const lead = schoolLeaveLead(10, 10);
assert(lead.leadMin === 20, "10 min walk plus 10 min traffic is still tracked, even though it no longer moves a fire time");
const rushed = trafficFromRoute(25, 10);
assert(rushed.trafficMin === 10, "Any rush on a 10 min walk adds a flat 10 min");
const heavyRush = trafficFromRoute(40, 10);
assert(heavyRush.trafficMin === 10, "Even a much slower route only adds the flat 10 min, not the full delta");
assert(trafficFromRoute(8, 10).trafficMin === 0, "A faster route does not shrink the normal walk");

// Class carries no leave reminder and no weather/traffic check at all — just
// one plain notification at the exact time the member set.
const start = Date.parse(klass.start);
const plan = buildPlan(
  { settings: { alarmsEnabled: true, classAlarms: true, leaveAlarms: true }, events: [klass], notes: [] },
  start - 60 * 60000
);
assert(!plan.some((p) => p.kind === "leave"), "Class has no leave reminder");
const classNow = plan.find((p) => p.role === "class" && p.kind === "alarm");
assert(classNow && classNow.at.getTime() === start, "Class rings exactly at the time the member set — not early");
assert(classNow.channel === "notification", "Class rings as a plain notification, not a critical alarm");
assert(plan.length === 1, "Class produces exactly one notification, nothing else");

// Sleep is now a plain exact-time notification — no notes, no checklist.
const sleep = {
  id: "s1",
  title: "Sleep",
  kind: "sleep",
  start: "2026-08-24T22:00:00",
  end: "2026-08-25T06:00:00",
  alarm: true,
};
const sleepPlan = buildPlan(
  { settings: { alarmsEnabled: true }, events: [sleep], notes: [] },
  Date.parse("2026-08-24T12:00:00")
);
assert(sleepPlan.length === 1, "Sleep produces exactly one notification");
assert(sleepPlan[0].at.getTime() === Date.parse(sleep.start), "Sleep's notification fires exactly at the set sleep time");
assert(!sleepPlan.some((p) => p.kind === "sleep-notes"), "Sleep itself no longer carries the notes/checklist reminder");

// The checklist (call Dad / prayed / open notes) is its own event now,
// decoupled from Sleep, firing exactly at its own set time.
const checklistEvent = {
  id: "ck1",
  title: "Before-sleep checklist",
  kind: "checklist",
  date: "2026-08-24",
  start: "2026-08-24T21:50:00",
  end: "2026-08-24T21:55:00",
  alarm: true,
};
const checklistPlan = buildPlan(
  { settings: { alarmsEnabled: true }, events: [checklistEvent], notes: [{ text: "Review biology", converted: false }] },
  Date.parse("2026-08-24T12:00:00")
);
const checklistNote = checklistPlan.find((p) => p.kind === "sleep-notes");
assert(
  checklistNote && checklistNote.at.getTime() === Date.parse(checklistEvent.start),
  "Checklist notification fires exactly at its own set time, not 10 minutes before anything"
);
assert(
  /Review biology/.test(checklistNote.body) && /call Dad/i.test(checklistNote.body) && /pray/i.test(checklistNote.body),
  "Checklist note includes her notes, Dad, and prayer"
);

// Wakeup is its own event now, decoupled from Sleep, ringing the critical
// alarm channel exactly at the time the member set.
const wakeupEvent = {
  id: "wk1",
  title: "Wake up",
  kind: "wakeup",
  start: "2026-08-25T06:00:00",
  end: "2026-08-25T06:05:00",
  alarm: true,
};
const wakeupPlan = buildPlan(
  { settings: { alarmsEnabled: true, wakeAlarms: true }, events: [wakeupEvent], notes: [] },
  Date.parse("2026-08-24T12:00:00")
);
const wake = wakeupPlan.find((p) => p.kind === "wake");
assert(wake && wake.at.getTime() === Date.parse(wakeupEvent.start), "Wakeup rings exactly at the time the member set");
assert(wake.channel === "alarm", "Wakeup rings on the critical alarm channel — the only event kind that does");
const wakeupEventItems = wakeupPlan.filter((p) => p.eventId === wakeupEvent.id);
assert(
  wakeupEventItems.every((p) => p.channel === "alarm"),
  "Every item from the Wakeup event is on the alarm channel — no separate plain notification"
);

if (failed) {
  console.error(`\n${failed} scheduler check(s) failed`);
  process.exit(1);
}
console.log("\nAll scheduler checks passed");
