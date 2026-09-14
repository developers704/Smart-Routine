import { buildNotificationPlan, NATIVE_ALARM_CAP } from "../client/alarms.js";

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
const start = new Date(now + 60 * 60 * 1000).toISOString();
const state = {
  settings: { alarmLeadMin: 10, notepadRemindMin: 21 * 60 + 30 },
  events: [
    { id: "a", title: "Gym", start, done: false, alarm: true },
    { id: "b", title: "Done", start, done: true, alarm: true },
    { id: "c", title: "Silent", start, done: false, alarm: false },
  ],
  notes: [{ text: "buy oats", converted: false }],
};

const plan = buildNotificationPlan(state, now);
const gym = plan.filter((p) => p.eventId === "a");
// Gym is an AlarmKit candidate on main: one on-time alarm, no lead notify.
assert(gym.length === 1, `Alarm-checked gym gets a single on-time alarm (got ${gym.length})`);
const gymAlarm = gym.find((p) => p.kind === "alarm");
assert(gymAlarm, "On-time alarm exists");
assert(!gym.some((p) => p.kind === "notify"), "Lead notification is not scheduled on the alarm channel");
assert(gymAlarm && gymAlarm.at.getTime() === Date.parse(start), "Alarm fires at event start");
assert(!plan.some((p) => p.eventId === "b" || p.eventId === "c"), "Done / alarm-off events are skipped");
assert(plan.some((p) => p.kind === "notepad"), "Open notepad gets an end-of-day reminder");

const flood = {
  settings: { alarmLeadMin: 10 },
  events: Array.from({ length: 80 }, (_, i) => ({
    id: `e${i}`,
    title: `E${i}`,
    start: new Date(now + (i + 2) * 60 * 60 * 1000).toISOString(),
    alarm: true,
  })),
  notes: [],
};
const capped = buildNotificationPlan(flood, now);
assert(capped.length === NATIVE_ALARM_CAP, `iOS pending cap ${NATIVE_ALARM_CAP} (got ${capped.length})`);
assert(capped[0].at <= capped[capped.length - 1].at, "Soonest fires are scheduled first");

if (failed) {
  console.error(`\n${failed} alarm check(s) failed`);
  process.exit(1);
}
console.log("\nAll alarm checks passed");
