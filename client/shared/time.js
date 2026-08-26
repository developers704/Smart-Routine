export const MIN = 1;
export const HOUR = 60;
export const DAY = 1440;

export function pad(n) {
  return String(n).padStart(2, "0");
}

export function isoDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

export function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export function addDays(iso, n) {
  const d = parseDate(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

export function dayOfWeek(iso) {
  return parseDate(iso).getDay();
}

export function weekNumber(iso) {
  const d = parseDate(iso);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

export function minutesToHm(min) {
  const m = ((min % DAY) + DAY) % DAY;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function hmToMin(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

export function at(iso, min) {
  const d = parseDate(iso);
  d.setMinutes(min);
  return d;
}

export function toISO(d) {
  return d.toISOString();
}

export function fromISO(s) {
  return new Date(s);
}

export function durationMin(start, end) {
  return Math.round((fromISO(end) - fromISO(start)) / 60000);
}

export function addMin(date, min) {
  return new Date(date.getTime() + min * 60000);
}

export function fmtTime(d) {
  const x = d instanceof Date ? d : fromISO(d);
  return `${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

export function fmtRange(start, end) {
  return `${fmtTime(start)}–${fmtTime(end)}`;
}

export function startOfWeek(iso) {
  const d = parseDate(iso);
  const diff = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - diff);
  return isoDate(d);
}

export function eachDate(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function uid(prefix = "e") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
