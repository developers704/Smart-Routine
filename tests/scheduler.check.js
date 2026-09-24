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
assert(rushed.trafficMin === 15 && rushed.leadMin === 25, "A 25 min route on a 10 min walk is 15 min of traffic");
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
assert(plan.some((p) => p.role === "class"), "The class itself is an AlarmKit alarm");

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

if (failed) {
  console.error(`\n${failed} scheduler check(s) failed`);
  process.exit(1);
}
console.log("\nAll scheduler checks passed");
