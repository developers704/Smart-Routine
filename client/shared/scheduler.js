import { DEFAULT_SETTINGS } from "./defaults.js";
import { addDays, addMin, at, durationMin, eachDate, fromISO, isoDate, parseDate } from "./time.js";

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
 * Build the day range from the user's own events. There is no auto-generated
 * shift day any more — a family member's routine is whatever class/sleep/
 * call-parent blocks they added, expanded across the range for recurring
 * ones. Locked/done auto events in `keep` are preserved.
 */
export function planRange({ userEvents = [], keep = [], from, to } = {}) {
  const expandedUser = expandRecurring(userEvents, addDays(from, -1), addDays(to, 1));
  const kept = (keep || []).filter((e) => e.locked);
  const events = [...expandedUser, ...kept].filter((e) => {
    const d = eventDay(e);
    return d >= from && d <= to;
  });
  events.sort((a, b) => fromISO(a.start) - fromISO(b.start));
  return events;
}

export function warningsFor(events, _shifts, settings = {}) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const notes = [];
  const byDate = {};
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
