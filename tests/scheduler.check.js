import { planRange } from "../client/shared/scheduler.js";
import { schoolLeaveLead, trafficFromRoute, leaveAlarmAt } from "../client/shared/school-leave.js";
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

const lead = schoolLeaveLead(10, 15);
assert(lead.leadMin === 25, "10 min walk plus 15 min traffic rings 25 min early");
const rushed = trafficFromRoute(25, 10);
assert(rushed.trafficMin === 15 && rushed.leadMin === 25, "Any rush on a 10 min walk adds a flat 15 min");
const heavyRush = trafficFromRoute(40, 10);
assert(heavyRush.trafficMin === 15, "Even a much slower route only adds the flat 15 min, not the full delta");
assert(trafficFromRoute(8, 10).trafficMin === 0, "A faster route does not shrink the normal walk");

const start = Date.parse(klass.start);
const plan = buildPlan(
  {
    settings: { alarmsEnabled: true, classAlarms: true, leaveAlarms: true, schoolWalkMin: 10, schoolTrafficMin: 15 },
    events: [klass],
    notes: [],
  },
  start - 60 * 60000
);
const leave = plan.find((p) => p.kind === "leave");
assert(leave && leave.at.getTime() === leaveAlarmAt(start, 25), "Class leave alarm is walk plus traffic before the class");
assert(leave.channel === "notification", "Leave-for-school rings as a plain notification, not a critical alarm");
const classNow = plan.find((p) => p.role === "class" && p.kind === "alarm");
assert(classNow && classNow.channel === "notification", "The class start itself rings as a plain notification too — only wake-up uses the alarm channel");

const sleep = {
  id: "s1",
  title: "Sleep",
  kind: "sleep",
  start: "2026-08-24T22:00:00",
  end: "2026-08-25T06:00:00",
  alarm: true,
};
const sleepPlan = buildPlan(
  {
    settings: { beforeSleepNotes: true, alarmsEnabled: true },
    events: [sleep],
    notes: [{ text: "Review biology", converted: false }],
  },
  Date.parse("2026-08-24T12:00:00")
);
const notes = sleepPlan.find((p) => p.kind === "sleep-notes");
assert(notes && notes.at.getTime() === Date.parse(sleep.start) - 10 * 60000, "Notes fire 10 minutes before sleep");
assert(
  /Review biology/.test(notes.body) && /call Dad/i.test(notes.body) && /pray/i.test(notes.body),
  "Sleep note includes her notes, Dad, and prayer"
);
// Regression: default alarmLeadMin (10) equals the hardcoded before-sleep-note
// offset (10), so the generic "In N min" reminder used to fire at the exact
// same instant as the notes reminder — two notifications back to back.
assert(
  !sleepPlan.some((p) => p.kind === "notify" && p.at.getTime() === notes.at.getTime()),
  "No duplicate generic lead reminder fires at the same instant as the before-sleep note"
);
assert(
  sleepPlan.filter((p) => p.at.getTime() === notes.at.getTime()).length === 1,
  "Only one notification fires 10 minutes before sleep"
);

if (failed) {
  console.error(`\n${failed} scheduler check(s) failed`);
  process.exit(1);
}
console.log("\nAll scheduler checks passed");
