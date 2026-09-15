/**
 * Family Tracker — roles, freshness, geofence, and alert de-dupe.
 * Pure: no DOM, no Capacitor, no network.
 */

export const ROLES = {
  PARENT: "parent",
  MEMBER: "member",
};

export const SEED_PROFILES = [
  { id: "user_kash", name: "Kash Valliani", role: ROLES.PARENT },
  { id: "user_anika", name: "Anika", role: ROLES.MEMBER },
];

export const STALE_AFTER_MS = 10 * 60 * 1000;
export const UNAVAILABLE_AFTER_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_HOME_RADIUS_M = 150;
export const DEFAULT_MONITOR = { startMin: 0, endMin: 5 * 60 };
export const LOCATION_RETENTION_DAYS = 14;

export function publicProfile(p) {
  return { id: p.id, name: p.name, role: p.role };
}

export function locationFreshness(updatedAt, now, { paused = false, permission = "authorized" } = {}) {
  if (paused) return "paused";
  if (permission === "denied") return "denied";
  if (permission === "disabled") return "disabled";
  if (!updatedAt) return "unavailable";
  const at = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(updatedAt);
  if (!Number.isFinite(at)) return "unavailable";
  const age = now - at;
  if (age > UNAVAILABLE_AFTER_MS) return "unavailable";
  if (age > STALE_AFTER_MS) return "stale";
  return "accurate";
}

/** Never label a stale or missing fix as Live. */
export function freshnessLabel(state) {
  if (state === "accurate") return "Updated";
  if (state === "stale") return "Stale";
  if (state === "paused") return "Sharing paused";
  if (state === "denied") return "Location permission denied";
  if (state === "disabled") return "Location off";
  return "Unavailable";
}

export function haversineMeters(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function isAtHome(point, home, radiusM = DEFAULT_HOME_RADIUS_M) {
  if (!point || !home || home.lat == null) return false;
  return haversineMeters(point, home) <= radiusM;
}

export function minutesOfDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getHours() * 60 + d.getMinutes();
}

/** Inclusive start, exclusive end. Overnight windows wrap midnight. */
export function inMonitorWindow(date, { startMin = 0, endMin = 5 * 60 } = DEFAULT_MONITOR) {
  const m = minutesOfDay(date);
  if (startMin === endMin) return true;
  if (startMin < endMin) return m >= startMin && m < endMin;
  return m >= startMin || m < endMin;
}

export function geofenceTransition({ wasHome, isHome, inWindow }) {
  if (!inWindow) return null;
  if (wasHome === true && isHome === false) return "away";
  if (wasHome === false && isHome === true) return "returned";
  return null;
}

/** One Away, then one Returned Home. Repeating the same state does not re-alert. */
export function shouldSendHomeAlert(lastAlert, next) {
  if (!next) return false;
  if (lastAlert === next) return false;
  return true;
}

export function homeAwayStatus(point, home, radiusM, freshness) {
  if (freshness === "unavailable" || freshness === "paused" || freshness === "denied" || freshness === "disabled") {
    return "unknown";
  }
  if (!point || !home) return "unknown";
  return isAtHome(point, home, radiusM) ? "home" : "away";
}

export function pruneLocationHistory(points, now, retentionDays = LOCATION_RETENTION_DAYS) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return (points || []).filter((p) => Date.parse(p.at) >= cutoff);
}

export function visitsAtPlaces(points, places, dayStart, dayEnd) {
  const list = (points || [])
    .filter((p) => {
      const t = Date.parse(p.at);
      return t >= dayStart && t < dayEnd;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out = [];
  for (const place of places || []) {
    if (place.lat == null) continue;
    let inside = false;
    let arrived = null;
    let departed = null;
    for (const p of list) {
      const here = haversineMeters(p, place) <= (place.radiusM || DEFAULT_HOME_RADIUS_M);
      if (here && !inside) {
        inside = true;
        arrived = p.at;
      } else if (!here && inside) {
        inside = false;
        departed = p.at;
      }
    }
    if (!arrived) continue;
    const end = departed ? Date.parse(departed) : dayEnd;
    out.push({
      placeId: place.id,
      name: place.name,
      arrivedAt: arrived,
      departedAt: departed,
      durationMin: Math.max(0, Math.round((end - Date.parse(arrived)) / 60000)),
      stillThere: inside && !departed,
    });
  }
  return out;
}

export function homeAlertBody({ memberName, kind, at }) {
  const when = at instanceof Date ? at.toISOString() : String(at);
  const action = kind === "returned" ? "returned home" : "is away from home";
  return `${memberName} ${action}. Last location ${when}. This is a notification with sound — it is not an alarm and may not break through Silent or Focus.`;
}

export function canReadFamilyLocation(reader, family) {
  if (!reader || !family) return false;
  if (!family.memberUserId) return false;
  if (family.parentUserId !== reader.id) return false;
  return reader.role === ROLES.PARENT;
}

export function canWriteFamilyLocation(writer, family) {
  if (!writer || !family) return false;
  if (family.memberUserId !== writer.id) return false;
  return writer.role === ROLES.MEMBER;
}
