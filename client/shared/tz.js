/**
 * Time-zone helpers.
 *
 * The Express server and the phone can sit in different zones, so anything that
 * means "21:30 where the user is" or renders a clock label has to be resolved
 * against an explicit zone rather than the host's local time.
 */

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    formatterFor(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Explicit setting wins; otherwise fall back to the host zone. */
export function resolveTimeZone(settings) {
  const tz = settings?.timeZone;
  return isValidTimeZone(tz) ? tz : systemTimeZone();
}

export function zonedParts(epochMs, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const out = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  // Midnight can format as hour 24 in some locales.
  if (out.hour === 24) out.hour = 0;
  return out;
}

function offsetMsAt(epochMs, timeZone) {
  const p = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - epochMs;
}

/** Epoch for a wall-clock time in `timeZone`, DST transitions included. */
export function epochForZonedTime(timeZone, { year, month, day, hour = 0, minute = 0 }) {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstPass = naiveUtc - offsetMsAt(naiveUtc, timeZone);
  return naiveUtc - offsetMsAt(firstPass, timeZone);
}

/** Same wall-clock time, `days` later in that zone. */
export function addZonedDays({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function clockLabel(epochMs, timeZone) {
  const p = zonedParts(epochMs, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
