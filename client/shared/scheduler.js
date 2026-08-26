import { SHIFT_DEFS, DEFAULT_SETTINGS } from "./defaults.js";
import {
  addDays,
  addMin,
  at,
  durationMin,
  eachDate,
  fromISO,
  isoDate,
  overlaps,
  parseDate,
  uid,
  weekNumber,
} from "./time.js";

export function eventDay(e) {
  if (e?.date && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date))) return e.date;
  return isoDate(fromISO(e.start));
}

export function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events || []) {
    const key = `${eventDay(e)}|${e.kind || ""}|${e.title || ""}|${e.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function mergePlan(existing, generated, from, to) {
  const outside = (existing || []).filter((e) => {
    const d = eventDay(e);
    return d < from || d > to;
  });
  const doneKeys = new Set();
  for (const e of existing || []) {
    const d = eventDay(e);
    if (e.source === "auto" && e.done && d >= from && d <= to) {
      doneKeys.add(`${d}|${e.kind}|${e.title}`);
    }
  }
  const next = (generated || []).map((e) => {
    if (e.source === "auto" && doneKeys.has(`${eventDay(e)}|${e.kind}|${e.title}`)) {
      return { ...e, done: true };
    }
    return e;
  });
  return dedupeEvents([...outside, ...next]);
}

export function isNight(code) {
  return code === "N" || code === "E+N";
}

export function isDay(code) {
  return code === "M" || code === "M+A";
}

export function shiftDef(code) {
  return code && SHIFT_DEFS[code] ? SHIFT_DEFS[code] : null;
}

function ev({ title, category, start, end, kind, date, alarm = true, extra = {} }) {
  return {
    id: uid("auto"),
    title,
    category,
    kind,
    start: start instanceof Date ? start.toISOString() : start,
    end: end instanceof Date ? end.toISOString() : end,
    date,
    done: false,
    alarm,
    source: "auto",
    locked: false,
    notes: extra.notes || "",
    templateKey: extra.templateKey || kind,
    ...extra,
  };
}

function busyList(events) {
  return events
    .map((e) => ({ start: fromISO(e.start), end: fromISO(e.end), event: e }))
    .sort((a, b) => a.start - b.start);
}

function collides(events, start, end, ignoreIds = new Set()) {
  const s = start instanceof Date ? start : fromISO(start);
  const t = end instanceof Date ? end : fromISO(end);
  return events.some((e) => {
    if (ignoreIds.has(e.id)) return false;
    return overlaps(s, t, fromISO(e.start), fromISO(e.end));
  });
}

/** Earliest gap of `need` minutes inside [windowStart, windowEnd]. */
export function findSlot(events, windowStart, windowEnd, need, prefer = "earliest") {
  const busy = busyList(events).filter(
    (b) => b.end > windowStart && b.start < windowEnd
  );
  const gaps = [];
  let cursor = new Date(windowStart);
  for (const b of busy) {
    if (b.start > cursor) gaps.push({ start: new Date(cursor), end: new Date(b.start) });
    if (b.end > cursor) cursor = new Date(b.end);
  }
  if (cursor < windowEnd) gaps.push({ start: new Date(cursor), end: new Date(windowEnd) });

  const fit = gaps.filter((g) => (g.end - g.start) / 60000 >= need);
  if (!fit.length) return null;
  const g = prefer === "latest" ? fit[fit.length - 1] : fit[0];
  if (prefer === "latest") {
    return { start: addMin(g.end, -need), end: new Date(g.end) };
  }
  return { start: new Date(g.start), end: addMin(g.start, need) };
}

function tryPlace(events, windowStart, windowEnd, need, prefer) {
  const slot = findSlot(events, windowStart, windowEnd, need, prefer);
  if (!slot) return null;
  return slot;
}

function workWindow(date, code) {
  const def = shiftDef(code);
  if (!def) return null;
  const start = at(date, def.startMin);
  const end = def.overnight ? at(addDays(date, 1), def.endMin) : at(date, def.endMin);
  return { start, end, def };
}

function commuteWindows(date, code, commuteMin) {
  const w = workWindow(date, code);
  if (!w) return [];
  return [
    { start: addMin(w.start, -commuteMin), end: w.start, leg: "to" },
    { start: w.end, end: addMin(w.end, commuteMin), leg: "from" },
  ];
}

function placeSleepNightBeforeDay(date, events, settings, prevCode) {
  if (isNight(prevCode)) return; // recovery sleep already covers this morning
  const wake = at(date, settings.wakeDayMin);
  const start = addMin(wake, -settings.sleepWorkMin);
  if (!collides(events, start, wake)) {
    events.push(
      ev({
        title: "Sleep",
        category: "sleep",
        kind: "sleep",
        start,
        end: wake,
        date,
        extra: { templateKey: "sleep" },
      })
    );
  }
}

function placeSleepOffMorning(date, events, settings, prevCode) {
  if (isNight(prevCode)) return;
  const wake = at(date, settings.wakeOffMin);
  const start = addMin(wake, -settings.sleepOffMin);
  if (!collides(events, start, wake)) {
    events.push(
      ev({
        title: "Sleep",
        category: "sleep",
        kind: "sleep",
        start,
        end: wake,
        date,
        extra: { templateKey: "sleep" },
      })
    );
  }
}

function recoveryDuration(nextCode, settings) {
  if (isNight(nextCode)) return settings.sleepWorkMin;
  if (isDay(nextCode)) return Math.min(settings.sleepWorkMin, 7 * 60);
  return Math.min(settings.sleepMaxMin, 10 * 60);
}

function afterNightRecovery(nightDate, nightCode, nextCode, events, settings, commuteMin) {
  const w = workWindow(nightDate, nightCode);
  if (!w) return;
  const homeEnd = addMin(w.end, commuteMin);
  const mealEnd = addMin(homeEnd, settings.dinnerWorkMin);
  const want = recoveryDuration(nextCode, settings);
  const latestWake = isDay(nextCode)
    ? at(addDays(nightDate, 1), settings.wakeDayMin + 8 * 60)
    : addMin(mealEnd, settings.sleepMaxMin);
  const windowEnd = latestWake;
  const slot = tryPlace(events, mealEnd, windowEnd, want, "earliest");
  if (!slot) {
    const fallback = tryPlace(
      events,
      mealEnd,
      addMin(mealEnd, settings.sleepMaxMin),
      Math.min(want, settings.sleepWorkMin),
      "earliest"
    );
    if (!fallback) return;
    events.push(
      ev({
        title: "Recovery sleep",
        category: "recovery",
        kind: "recovery",
        start: fallback.start,
        end: fallback.end,
        date: addDays(nightDate, 1),
        extra: {
          templateKey: "recovery",
          notes: transitionNote(nightCode, nextCode),
        },
      })
    );
    return;
  }
  events.push(
    ev({
      title: "Recovery sleep",
      category: "recovery",
      kind: "recovery",
      start: slot.start,
      end: slot.end,
      date: addDays(nightDate, 1),
      extra: {
        templateKey: "recovery",
        notes: transitionNote(nightCode, nextCode),
      },
    })
  );
}

function transitionNote(from, to) {
  const t = to || "OFF";
  return `Transition ${from} → ${t}. Sleep capped at 12h. Protect the next block of wake time.`;
}

function placePreNightSleep(date, code, prevCode, events, settings) {
  const w = workWindow(date, code);
  if (!w) return;
  const commuteStart = addMin(w.start, -settings.commuteMin);
  const need = isDay(prevCode) || !prevCode ? settings.sleepWorkMin : settings.sleepWorkMin;
  // leave ~90m after sleep for meal + prep before commute
  const prep = 60;
  const sleepEnd = addMin(commuteStart, -prep);
  const sleepStart = addMin(sleepEnd, -need);
  const dayStart = at(date, 8 * 60);
  const windowStart =
    isNight(prevCode) ? at(date, 16 * 60) : at(date, prevCode && isDay(prevCode) ? 16 * 60 : 9 * 60);
  const slot = tryPlace(
    events,
    windowStart < sleepStart ? windowStart : at(date, 8 * 60),
    sleepEnd,
    need,
    "latest"
  );
  if (slot) {
    const fromOff = !prevCode;
    const fromDay = isDay(prevCode);
    events.push(
      ev({
        title: fromDay || fromOff ? "Transition sleep" : "Sleep",
        category: fromDay || fromOff ? "recovery" : "sleep",
        kind: fromDay || fromOff ? "recovery" : "sleep",
        start: slot.start,
        end: slot.end,
        date,
        extra: {
          templateKey: "sleep",
          notes: prevCode
            ? transitionNote(prevCode, code)
            : "Off → night: later sleep so you are awake for the shift.",
        },
      })
    );
  } else if (!collides(events, sleepStart, sleepEnd) && sleepStart >= dayStart) {
    events.push(
      ev({
        title: "Sleep",
        category: "sleep",
        kind: "sleep",
        start: sleepStart,
        end: sleepEnd,
        date,
      })
    );
  }
}

function placeWorkAndCommute(date, code, events, settings) {
  if (events.some((e) => e.date === date && e.kind === "work")) return;
  const w = workWindow(date, code);
  if (!w) return;
  const [toWork, fromWork] = commuteWindows(date, code, settings.commuteMin);
  events.push(
    ev({
      title: `Commute to hospital`,
      category: "commute",
      kind: "commute",
      start: toWork.start,
      end: toWork.end,
      date,
      extra: {
        templateKey: "commute",
        notes: settings.callParentsOnCommute ? "Call parents" : "",
        subtitle: settings.callParentsOnCommute ? "Call parents" : "",
      },
    })
  );
  events.push(
    ev({
      title: `Shift ${w.def.label}`,
      category: "work",
      kind: "work",
      start: w.start,
      end: w.end,
      date,
      extra: { templateKey: "work", shift: code },
    })
  );
  events.push(
    ev({
      title: `Commute home`,
      category: "commute",
      kind: "commute",
      start: fromWork.start,
      end: fromWork.end,
      date,
      extra: {
        templateKey: "commute",
        notes: settings.callParentsOnCommute ? "Call parents" : "",
        subtitle: settings.callParentsOnCommute ? "Call parents" : "",
      },
    })
  );
}

function placeJk(date, code, events, settings) {
  if (code === "E+N") return;
  const start = at(date, settings.jkStartMin);
  const end = addMin(start, settings.jkDurationMin);
  if (collides(events, start, end)) return;
  events.push(
    ev({
      title: "JK",
      category: "prayer",
      kind: "jk",
      start,
      end,
      date,
      extra: { templateKey: "jk", notes: "Mandatory unless E+N" },
    })
  );
}

function placeWorkMeals(date, code, events, settings) {
  const w = workWindow(date, code);
  if (!w) return;
  const commuteStart = addMin(w.start, -settings.commuteMin);
  if (isDay(code)) {
    const bEnd = commuteStart;
    const bStart = addMin(bEnd, -settings.breakfastWorkMin);
    if (!collides(events, bStart, bEnd)) {
      events.push(
        ev({
          title: "Breakfast",
          category: "meal",
          kind: "breakfast",
          start: bStart,
          end: bEnd,
          date,
          extra: { templateKey: "breakfast" },
        })
      );
    }
    const home = addMin(w.end, settings.commuteMin);
    const dEnd = addMin(home, settings.dinnerWorkMin);
    if (!collides(events, home, dEnd)) {
      events.push(
        ev({
          title: "Dinner",
          category: "meal",
          kind: "dinner",
          start: home,
          end: dEnd,
          date,
          extra: { templateKey: "dinner" },
        })
      );
    }
  } else {
    const home = addMin(w.end, settings.commuteMin);
    const mealEnd = addMin(home, settings.dinnerWorkMin);
    if (!collides(events, home, mealEnd)) {
      events.push(
        ev({
          title: "Meal after shift",
          category: "meal",
          kind: "dinner",
          start: home,
          end: mealEnd,
          date: addDays(date, 1),
          extra: { templateKey: "dinner" },
        })
      );
    }
    const toWork = addMin(w.start, -settings.commuteMin);
    const bEnd = toWork;
    const bStart = addMin(bEnd, -settings.breakfastWorkMin);
    if (!collides(events, bStart, bEnd)) {
      events.push(
        ev({
          title: "Pre-shift meal",
          category: "meal",
          kind: "breakfast",
          start: bStart,
          end: bEnd,
          date,
          extra: { templateKey: "breakfast" },
        })
      );
    }
  }
}

function placeOffMeals(date, events, settings) {
  const wakeEvent = events
    .filter((e) => e.date === date && (e.kind === "sleep" || e.kind === "recovery"))
    .sort((a, b) => fromISO(a.end) - fromISO(b.end))[0];
  const wake = wakeEvent ? fromISO(wakeEvent.end) : at(date, settings.wakeOffMin);
  const dayEnd = at(addDays(date, 1), 0);
  const breakfast = tryPlace(
    events,
    wake,
    addMin(wake, 3 * 60),
    settings.breakfastOffMin,
    "earliest"
  );
  if (!breakfast) return;
  events.push(
    ev({
      title: "Breakfast",
      category: "meal",
      kind: "breakfast",
      start: breakfast.start,
      end: breakfast.end,
      date,
      extra: { templateKey: "breakfast" },
    })
  );
  const lunchEarliest = addMin(breakfast.end, settings.mealGapMin);
  const lunch = tryPlace(
    events,
    lunchEarliest,
    addMin(lunchEarliest, 4 * 60),
    settings.lunchOffMin,
    "earliest"
  );
  if (!lunch) return;
  events.push(
    ev({
      title: "Lunch",
      category: "meal",
      kind: "lunch",
      start: lunch.start,
      end: lunch.end,
      date,
      extra: { templateKey: "lunch" },
    })
  );
  const dinnerEarliest = addMin(lunch.end, settings.mealGapMin);
  const dinner = tryPlace(
    events,
    dinnerEarliest,
    dayEnd,
    settings.dinnerOffMin,
    "earliest"
  );
  if (!dinner) return;
  events.push(
    ev({
      title: "Dinner",
      category: "meal",
      kind: "dinner",
      start: dinner.start,
      end: dinner.end,
      date,
      extra: { templateKey: "dinner" },
    })
  );
}

function placeStudy(date, code, events, settings) {
  let need = code ? Math.min(settings.mcatWorkMinMax, settings.mcatWorkMin) : settings.mcatOffMin;
  const dayStart = at(date, code && isNight(code) ? 10 * 60 : 8 * 60);
  const dayEnd = isNight(code)
    ? addMin(workWindow(date, code).start, -settings.commuteMin - 30)
    : at(date, 22 * 60 + 30);
  while (need >= 45) {
    const want = Math.min(need, code ? need : 120);
    const slot =
      tryPlace(events, dayStart, dayEnd, want, "earliest") ||
      tryPlace(events, dayStart, dayEnd, Math.min(need, 45), "earliest");
    if (!slot) break;
    events.push(
      ev({
        title: "MCAT studying",
        category: "study",
        kind: "mcat",
        start: slot.start,
        end: slot.end,
        date,
        extra: { templateKey: "mcat" },
      })
    );
    need -= (slot.end - slot.start) / 60000;
  }
}

function freeMinutes(date, events) {
  const start = at(date, 8 * 60);
  const end = at(date, 22 * 60);
  let free = 14 * 60;
  for (const e of events) {
    const s = fromISO(e.start);
    const t = fromISO(e.end);
    if (t <= start || s >= end) continue;
    const a = s < start ? start : s;
    const b = t > end ? end : t;
    free -= (b - a) / 60000;
  }
  return Math.max(0, free);
}

function placeNamed(events, date, title, category, kind, need, extra = {}) {
  const start = at(date, 7 * 60);
  const end = at(date, 22 * 60);
  const slot = tryPlace(events, start, end, need, "earliest");
  if (!slot) return false;
  events.push(
    ev({
      title,
      category,
      kind,
      start: slot.start,
      end: slot.end,
      date,
      extra: { templateKey: kind, ...extra },
    })
  );
  return true;
}

function placeOnFirstFit(pool, events, title, category, kind, need) {
  for (const p of pool) {
    if (placeNamed(events, p.date, title, category, kind, need)) return true;
  }
  return false;
}

function placeWeekly(dates, shifts, events, settings, fromIso) {
  const scored = dates
    .map((d) => ({
      date: d,
      code: shifts[d] || null,
      free: freeMinutes(d, events),
    }))
    .sort((a, b) => b.free - a.free);

  const gymPool = scored.filter((s) => s.code !== "M+A" && s.code !== "E+N");
  let gyms = 0;
  for (const g of gymPool) {
    if (gyms >= settings.gymPerWeek) break;
    if (placeNamed(events, g.date, "Gym", "gym", "gym", settings.gymMin)) gyms++;
  }

  const chorePool = scored.filter((s) => !isNight(s.code));
  placeOnFirstFit(chorePool, events, "Laundry", "chore", "laundry", settings.laundryMin);

  const week = weekNumber(fromIso);
  if (week % 2 === 0) {
    placeOnFirstFit(chorePool, events, "Groceries", "chore", "groceries", settings.groceriesMin);
  }

  let prepped = 0;
  for (const p of chorePool) {
    if (prepped >= settings.mealPrepPerWeek) break;
    if (placeNamed(events, p.date, "Meal prep", "chore", "mealprep", settings.mealPrepMin)) {
      prepped++;
    }
  }

  let choresLeft = settings.choresWeekMin;
  const chunk = 60;
  for (const s of scored) {
    if (choresLeft <= 0) break;
    const n = Math.min(chunk, choresLeft);
    if (placeNamed(events, s.date, "Miscellaneous chores", "chore", "chores", n)) {
      choresLeft -= n;
    }
  }
}

function expandRecurring(userEvents, from, to) {
  const out = [];
  for (const e of userEvents) {
    if (!e.recurring) {
      const d = isoDate(fromISO(e.start));
      if (d >= from && d <= to) out.push({ ...e });
      continue;
    }
    const rule = e.recurring;
    for (const d of eachDate(from, to)) {
      const dow = parseDate(d).getDay();
      if (rule.weekdays && rule.weekdays.length && !rule.weekdays.includes(dow)) continue;
      if (rule.freq === "weekly" && rule.weekdays && !rule.weekdays.includes(dow)) continue;
      if (rule.freq === "daily" || rule.freq === "weekly") {
        const start0 = fromISO(e.start);
        const dur = durationMin(e.start, e.end);
        const start = at(d, start0.getHours() * 60 + start0.getMinutes());
        out.push({
          ...e,
          id: `${e.id}_${d}`,
          start: start.toISOString(),
          end: addMin(start, dur).toISOString(),
          date: d,
          occurrenceOf: e.id,
        });
      }
    }
  }
  return out;
}

/**
 * Build auto schedule. User events are treated as busy and copied through.
 * Locked/done auto events in `keep` are preserved.
 */
export function planRange({ shifts, userEvents = [], keep = [], settings = {}, from, to }) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const dates = eachDate(from, to);
  const expandedUser = expandRecurring(userEvents, addDays(from, -1), addDays(to, 1));
  const kept = keep.filter((e) => e.locked);
  const events = [...expandedUser, ...kept];

  for (const date of dates) {
    const code = shifts[date] || null;
    if (code) placeWorkAndCommute(date, code, events, cfg);
  }

  for (const date of dates) {
    const code = shifts[date] || null;
    const prev = shifts[addDays(date, -1)] || null;
    const next = shifts[addDays(date, 1)] || null;

    if (isDay(code)) placeSleepNightBeforeDay(date, events, cfg, prev);
    else if (!code) placeSleepOffMorning(date, events, cfg, prev);
    else if (isNight(code)) placePreNightSleep(date, code, prev, events, cfg);

    if (isNight(code)) afterNightRecovery(date, code, next, events, cfg, cfg.commuteMin);
  }

  for (const date of dates) {
    const code = shifts[date] || null;
    placeJk(date, code, events, cfg);
    if (code) placeWorkMeals(date, code, events, cfg);
    else placeOffMeals(date, events, cfg);
  }

  for (let i = 0; i < dates.length; i += 7) {
    const chunk = dates.slice(i, i + 7);
    if (chunk.length) placeWeekly(chunk, shifts, events, cfg, chunk[0]);
  }

  for (const date of dates) {
    const code = shifts[date] || null;
    placeStudy(date, code, events, cfg);
  }

  events.sort((a, b) => fromISO(a.start) - fromISO(b.start));
  return events;
}

export function warningsFor(events, shifts, settings = {}) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const notes = [];
  const byDate = {};
  for (const [d, code] of Object.entries(shifts)) {
    if (!code) continue;
    const next = shifts[addDays(d, 1)];
    if (isNight(code) && isDay(next)) {
      notes.push({
        date: addDays(d, 1),
        text: `Tight turnaround: ${code} into ${next}. Recovery sleep may collide with the day shift.`,
      });
    }
    if (isDay(code) && isNight(next) && code === "M+A" && next === "E+N") {
      notes.push({
        date: d,
        text: "M+A into E+N has no gap between shifts.",
      });
    }
  }
  for (const e of events) {
    if (e.kind === "sleep" || e.kind === "recovery") {
      const dur = durationMin(e.start, e.end);
      if (dur > cfg.sleepMaxMin) {
        notes.push({ date: e.date, text: `Sleep block exceeds 12h (${Math.round(dur / 60)}h).` });
      }
    }
    const d = (byDate[e.date] ||= []);
    d.push(e);
  }
  return notes;
}
