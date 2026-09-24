import { addDays, isoDate, startOfWeek } from "./time.js";

export const SHIFT_DEFS = {
  M: {
    code: "M",
    label: "Morning",
    short: "M",
    startMin: 7 * 60,
    endMin: 15 * 60,
    overnight: false,
    kind: "day",
    hours: 8,
  },
  "M+A": {
    code: "M+A",
    label: "Day 12h",
    short: "M+A",
    startMin: 7 * 60,
    endMin: 19 * 60,
    overnight: false,
    kind: "day",
    hours: 12,
  },
  "E+N": {
    code: "E+N",
    label: "Eve + Night",
    short: "E+N",
    startMin: 19 * 60,
    endMin: 7 * 60,
    overnight: true,
    kind: "night",
    hours: 12,
  },
  N: {
    code: "N",
    label: "Night",
    short: "N",
    startMin: 23 * 60,
    endMin: 7 * 60,
    overnight: true,
    kind: "night",
    hours: 8,
  },
};

export const DEFAULT_SETTINGS = {
  commuteMin: 30,
  jkStartMin: 19 * 60,
  jkDurationMin: 120,
  mcatWorkMin: 120,
  mcatWorkMinMax: 180,
  mcatOffMin: 360,
  mcatBreakMin: 8,
  sleepWorkMin: 7 * 60,
  sleepOffMin: 8 * 60,
  sleepMaxMin: 12 * 60,
  wakeDayMin: 6 * 60,
  wakeOffMin: 8 * 60,
  breakfastWorkMin: 30,
  dinnerWorkMin: 60,
  breakfastOffMin: 60,
  lunchOffMin: 60,
  dinnerOffMin: 60,
  mealGapMin: 4 * 60,
  laundryMin: 60,
  laundryEveryDays: 7,
  groceriesMin: 90,
  groceriesEveryDays: 14,
  mealPrepMin: 90,
  mealPrepPerWeek: 2,
  gymMin: 90,
  gymPerWeek: 3,
  choresWeekMin: 150,
  choresWeekMax: 240,
  alarmLeadMin: 10,
  schoolWalkMin: 10,
  schoolTrafficMin: 0,
  beforeSleepNotes: true,
  notepadRemindMin: 21 * 60 + 30,
  callParentsOnCommute: true,
  callParentsDelayMin: 5,
  timeZone: null,
  alarmsEnabled: true,
  wakeAlarms: true,
  shiftAlarms: true,
  classAlarms: true,
  leaveAlarms: true,
  snoozeMin: 9,
  wakeVerificationEnabled: true,
  wakeVerificationMethod: "math",
  mathDifficulty: "medium",
  mathQuestionCount: 1,
  backupAlarmCount: 4,
  backupIntervalSec: 30,
  backupIntervalMin: 1,
};

/** Mon→Sun. `null` is off. Change any day in the app; this is only the starting roster. */
export const DEFAULT_WEEKDAY_SHIFTS = [null, null, "M", "M", "M", null, "M+A"];

export function shiftsForWeek(mondayIso, codes = DEFAULT_WEEKDAY_SHIFTS) {
  const shifts = {};
  for (let i = 0; i < 7; i++) {
    if (codes[i]) shifts[addDays(mondayIso, i)] = codes[i];
  }
  return shifts;
}

export function fillEmptyWeekShifts(shifts = {}, mondayIso, codes = DEFAULT_WEEKDAY_SHIFTS) {
  const out = { ...(shifts || {}) };
  const week = [];
  for (let i = 0; i < 7; i++) week.push(addDays(mondayIso, i));
  if (week.some((d) => Object.prototype.hasOwnProperty.call(out, d))) return out;
  return { ...out, ...shiftsForWeek(mondayIso, codes) };
}

export function defaultShiftsForToday(now = new Date()) {
  return shiftsForWeek(startOfWeek(isoDate(now)));
}

export function fillEmptyWeeksInRange(shifts, from, to, codes = DEFAULT_WEEKDAY_SHIFTS) {
  let out = { ...(shifts || {}) };
  let monday = startOfWeek(from);
  while (monday <= to) {
    out = fillEmptyWeekShifts(out, monday, codes);
    monday = addDays(monday, 7);
  }
  return out;
}

export const CATEGORIES = {
  sleep: { label: "Sleep", tone: "sleep" },
  recovery: { label: "Recovery sleep", tone: "recovery" },
  work: { label: "Shift", tone: "work" },
  commute: { label: "Commute", tone: "commute" },
  meal: { label: "Meal", tone: "meal" },
  prayer: { label: "JK", tone: "prayer" },
  study: { label: "MCAT", tone: "study" },
  gym: { label: "Gym", tone: "gym" },
  chore: { label: "Chore", tone: "chore" },
  personal: { label: "Personal", tone: "personal" },
  commuteCall: { label: "Call parents", tone: "commute" },
};
