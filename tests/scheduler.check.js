import { planRange } from "../client/shared/scheduler.js";
import { addDays, clipToDay, durationMin, fmtTime, fromISO, isoDate, overlapsDay } from "../client/shared/time.js";
import { DEFAULT_SETTINGS } from "../client/shared/defaults.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

const monday = "2026-08-24"; // Monday
const shifts = {
  [monday]: "M",
  [addDays(monday, 1)]: "M+A",
  [addDays(monday, 2)]: null,
  [addDays(monday, 3)]: "N",
  [addDays(monday, 4)]: "E+N",
  [addDays(monday, 5)]: null,
  [addDays(monday, 6)]: null,
};

const events = planRange({
  shifts,
  userEvents: [],
  keep: [],
  settings: DEFAULT_SETTINGS,
  from: monday,
  to: addDays(monday, 6),
});

const on = (date, kind) => events.filter((e) => e.date === date && e.kind === kind);
const titlesOn = (date) => events.filter((e) => e.date === date).map((e) => e.title);

assert(on(monday, "work").length === 1, "Monday has a shift block");
assert(on(monday, "commute").length === 2, "Monday has two commutes");
assert(on(monday, "jk").length === 0, "JK is Friday-only, not Monday");
assert(on(addDays(monday, 1), "jk").length === 0, "JK is Friday-only, not Tuesday M+A");
assert(on(addDays(monday, 4), "jk").length === 0, "Friday E+N skips JK");
assert(on(addDays(monday, 6), "jk").length === 0, "JK is Friday-only, not Sunday");

const mWake = events.find((e) => e.kind === "sleep" && e.date === monday);
assert(mWake, "M day has sleep ending at wake");
if (mWake) {
  const end = fromISO(mWake.end);
  assert(end.getHours() === 6 && end.getMinutes() === 0, "M wake is 06:00");
  assert(durationMin(mWake.start, mWake.end) === 7 * 60, "Work night sleep is 7h");
  assert(fmtTime(end) === "6:00 AM", "Times render as AM/PM");
  assert(clipToDay(mWake.start, mWake.end, monday).start.getHours() === 0, "Wake-day sleep is clipped from midnight");
  assert(overlapsDay(mWake.start, mWake.end, addDays(monday, -1)), "Overnight sleep also belongs to the previous calendar day");
}

const off = addDays(monday, 2);
const offSleep = events.find((e) => (e.kind === "sleep" || e.kind === "recovery") && isoDate(fromISO(e.end)) === off);
assert(offSleep, "Off day has a sleep block ending that morning");
if (offSleep && !shifts[addDays(off, -1)]) {
  const end = fromISO(offSleep.end);
  assert(end.getHours() === 8, "Off-day wake is 08:00");
}

const meals = events.filter((e) => e.date === off && e.category === "meal").sort((a, b) => fromISO(a.start) - fromISO(b.start));
assert(meals.length >= 2, "Off day has multiple meals");
if (meals.length >= 2) {
  for (let i = 1; i < meals.length; i++) {
    const gap = (fromISO(meals[i].start) - fromISO(meals[i - 1].end)) / 60000;
    assert(gap >= 4 * 60 - 1, `Off meals ${i - 1}/${i} are at least 4h apart (gap ${gap})`);
  }
}

const gyms = events.filter((e) => e.kind === "gym");
assert(gyms.length === 3, `Gym 3x this week (got ${gyms.length})`);
assert(events.some((e) => e.kind === "laundry"), "Laundry once this week");
assert(events.some((e) => e.kind === "mealprep"), "Meal prep exists");
const choresHrs = events.filter((e) => e.kind === "chores").reduce((s, e) => s + durationMin(e.start, e.end), 0);
assert(choresHrs >= 60, `Misc chores distributed (got ${choresHrs}m)`);

const studyOff = events.filter((e) => e.date === off && e.kind === "mcat").reduce((s, e) => s + durationMin(e.start, e.end), 0);
assert(studyOff >= 60, `Off-day MCAT gets a real block (got ${studyOff}m)`);

const commuteNotes = events.filter((e) => e.kind === "commute" && /Call parents/.test(e.notes + (e.subtitle || "")));
assert(commuteNotes.length >= 2, "Commutes remind to call parents");

const recovery = events.filter((e) => e.kind === "recovery");
assert(recovery.length >= 1, `Night transitions get recovery sleep (got ${recovery.length})`);

const mWork = on(monday, "work")[0];
assert(mWork && durationMin(mWork.start, mWork.end) === 8 * 60, "M shift is 8 hours");
const ma = addDays(monday, 1);
const maWork = on(ma, "work")[0];
assert(maWork && durationMin(maWork.start, maWork.end) === 12 * 60, "M+A shift is 12 hours");
const nDate = addDays(monday, 3);
const nWork = on(nDate, "work")[0];
assert(nWork && durationMin(nWork.start, nWork.end) === 8 * 60, "N shift is 8 hours");
const en = addDays(monday, 4);
const enWork = on(en, "work")[0];
assert(enWork && durationMin(enWork.start, enWork.end) === 12 * 60, "E+N shift is 12 hours");

for (const c of on(monday, "commute")) {
  assert(durationMin(c.start, c.end) === 30, `Commute is 30 min (${c.title})`);
}

const jk = on(monday, "jk")[0];
assert(!jk, "Sample week has no Monday JK");

const fridayM = planRange({
  shifts: { "2026-08-28": "M" },
  userEvents: [],
  keep: [],
  settings: DEFAULT_SETTINGS,
  from: "2026-08-28",
  to: "2026-08-28",
});
const fridayJk = fridayM.filter((e) => e.kind === "jk")[0];
assert(fridayJk && fromISO(fridayJk.start).getHours() === 19, "Friday M gets JK at 7:00 PM");
assert(fridayJk && durationMin(fridayJk.start, fridayJk.end) === 120, "JK is 2 hours");

const bf = events.find((e) => e.date === monday && e.kind === "breakfast");
assert(bf && durationMin(bf.start, bf.end) === 30, "Workday breakfast is 30 min");
const dn = events.find((e) => e.date === monday && e.kind === "dinner");
assert(dn && durationMin(dn.start, dn.end) === 60, "Workday dinner is 1 hour");

const preps = events.filter((e) => e.kind === "mealprep");
assert(preps.length === 2, `Meal prep twice this week (got ${preps.length})`);
assert(preps.every((e) => durationMin(e.start, e.end) === 90), "Meal prep is 1.5h");
assert(events.filter((e) => e.kind === "laundry").every((e) => durationMin(e.start, e.end) === 60), "Laundry is 1h");
assert(gyms.every((e) => durationMin(e.start, e.end) === 90), "Gym is 1.5h");

const studyWork = events.filter((e) => e.date === monday && e.kind === "mcat");
assert(studyWork.length === 1 && durationMin(studyWork[0].start, studyWork[0].end) === 120, "Workday MCAT is one 2h session");
assert(studyOff >= 180, `Off-day MCAT gets a real block (got ${studyOff}m; 6h target, leftover after chores)`);

const quietOff = planRange({
  shifts: {},
  userEvents: [],
  keep: [],
  settings: {
    ...DEFAULT_SETTINGS,
    gymPerWeek: 0,
    mealPrepPerWeek: 0,
    choresWeekMin: 0,
    laundryMin: 10_000,
    groceriesMin: 10_000,
  },
  from: off,
  to: off,
});
const quietMcat = quietOff.filter((e) => e.kind === "mcat").sort((a, b) => fromISO(a.start) - fromISO(b.start));
assert(
  quietMcat.length === 3 && quietMcat.every((e) => durationMin(e.start, e.end) === 120),
  `Off-day MCAT is three 2h sessions (got ${quietMcat.map((e) => durationMin(e.start, e.end)).join(",")})`
);
for (let i = 1; i < quietMcat.length; i++) {
  const gap = (fromISO(quietMcat[i].start) - fromISO(quietMcat[i - 1].end)) / 60000;
  assert(gap >= 5 && gap <= 10, `MCAT sessions have a 5–10 min break (got ${gap})`);
}

const withUser = planRange({
  shifts,
  userEvents: [
    {
      id: "once",
      title: "One-time clinic",
      source: "user",
      kind: "personal",
      category: "personal",
      start: new Date(2026, 7, 24, 21, 0).toISOString(),
      end: new Date(2026, 7, 24, 21, 30).toISOString(),
      date: monday,
    },
    {
      id: "weekly",
      title: "Weekly review",
      source: "user",
      kind: "personal",
      category: "personal",
      recurring: { freq: "weekly", weekdays: [1] },
      start: new Date(2026, 7, 24, 21, 45).toISOString(),
      end: new Date(2026, 7, 24, 22, 15).toISOString(),
      date: monday,
    },
  ],
  keep: [],
  settings: DEFAULT_SETTINGS,
  from: monday,
  to: addDays(monday, 6),
});
assert(withUser.some((e) => e.title === "One-time clinic"), "One-time user event is kept");
assert(withUser.filter((e) => e.title === "Weekly review").length >= 1, "Weekly recurring user event expands");

for (const e of events) {
  if (e.kind === "sleep" || e.kind === "recovery") {
    assert(durationMin(e.start, e.end) <= 12 * 60, `${e.title} under 12h`);
  }
}

console.log("events", events.length, "sample", titlesOn(monday).slice(0, 8));
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll scheduler checks passed");
