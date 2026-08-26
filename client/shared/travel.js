export const PURPOSES = [
  { id: "office", label: "Office" },
  { id: "meeting", label: "Meeting" },
  { id: "shopping", label: "Shopping" },
  { id: "prayer", label: "Prayer" },
  { id: "home", label: "Home" },
  { id: "gym", label: "Gym" },
  { id: "other", label: "Other" },
];

export const MODES = [
  { id: "walking", label: "Walk" },
  { id: "driving", label: "Drive" },
  { id: "cycling", label: "Bike" },
];

/** Seeded so Home ↔ BIDMC works even before geocode. */
export const DEFAULT_PLACES = [
  {
    id: "place_home",
    purpose: "home",
    name: "Home",
    address: "85 Park Drive Apt 24, Boston, MA 02215",
    lat: 42.3468,
    lng: -71.1039,
  },
  {
    id: "place_office",
    purpose: "office",
    name: "Office",
    address: "Beth Israel Deaconess Medical Center, 330 Brookline Avenue, Boston, MA",
    lat: 42.3376,
    lng: -71.1068,
  },
];

const geoCache = new Map();

export function ensurePlaces(places) {
  const list = Array.isArray(places) ? places.map((p) => ({ ...p })) : [];
  for (const seed of DEFAULT_PLACES) {
    if (!list.some((p) => p.id === seed.id || (p.purpose === seed.purpose && /^(home|office)$/i.test(p.name)))) {
      list.unshift({ ...seed });
    }
  }
  return list;
}

export function haversineKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function fallbackMin(km, mode) {
  const perKm = mode === "driving" ? 3.2 : mode === "cycling" ? 4.5 : 12;
  return Math.max(1, Math.round(km * perKm + (mode === "driving" ? 3 : 0)));
}

export function defaultsForPurpose(purpose, places) {
  const dest = places.find((p) => p.purpose === purpose);
  const home = places.find((p) => p.purpose === "home");
  const office = places.find((p) => p.purpose === "office");
  if (purpose === "home") return { fromId: office?.id || "here", toId: home?.id || "" };
  if (purpose === "office") return { fromId: home?.id || "here", toId: office?.id || "" };
  return { fromId: home?.id || "here", toId: dest?.id || "" };
}

export function coordOf(id, places, here) {
  if (id === "here") return here?.lat != null ? here : null;
  const p = places.find((x) => x.id === id);
  if (!p || p.lat == null) return null;
  return { lat: p.lat, lng: p.lng, name: p.name, address: p.address };
}

async function fetchJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function geocode(address) {
  const q = String(address || "").trim();
  if (!q) return null;
  if (geoCache.has(q)) return geoCache.get(q);
  const hits = await searchPlaces(q, 1);
  const hit = hits[0];
  if (!hit) return null;
  const pt = { lat: hit.lat, lng: hit.lng };
  geoCache.set(q, pt);
  return pt;
}

export function bostonQuery(q) {
  const s = String(q || "").trim();
  if (!s) return "";
  return /boston|massachusetts|\bma\b/i.test(s) ? s : `${s} Boston MA`;
}

export async function searchPlaces(query, limit = 5) {
  const q = bostonQuery(query);
  if (q.length < 2) return [];
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${limit}` +
    `&addressdetails=1&q=${encodeURIComponent(q)}` +
    `&viewbox=-71.20,42.40,-71.00,42.30`;
  const rows = await fetchJson(url);
  return (rows || []).map((hit) => ({
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    name: shortName(hit),
    address: hit.display_name,
  }));
}

export async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18`;
  const hit = await fetchJson(url);
  if (!hit) return null;
  return {
    lat: Number(hit.lat || lat),
    lng: Number(hit.lon || lng),
    name: shortName(hit),
    address: hit.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
  };
}

function shortName(hit) {
  const n = hit.name || hit.address?.amenity || hit.address?.shop || hit.address?.leisure || "";
  if (n) return n;
  return String(hit.display_name || "").split(",")[0].trim();
}

export async function routeBetween(from, to, mode = "walking") {
  const profile = MODES.some((m) => m.id === mode) ? mode : "walking";
  const url = `https://router.project-osrm.org/route/v1/${profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  try {
    const data = await fetchJson(url);
    const r = data?.routes?.[0];
    if (!r) throw new Error("no route");
    return {
      km: r.distance / 1000,
      min: Math.max(1, Math.round(r.duration / 60)),
      geometry: r.geometry,
      source: "osrm",
    };
  } catch {
    const km = haversineKm(from, to);
    return { km, min: fallbackMin(km, profile), geometry: null, source: "estimate" };
  }
}

export function mapsUrl(to, mode) {
  const q = encodeURIComponent(to.address || `${to.lat},${to.lng}`);
  const dirflg = mode === "driving" ? "d" : mode === "cycling" ? "b" : "w";
  return `https://maps.apple.com/?daddr=${q}&dirflg=${dirflg}`;
}

export function roundLeaveLocal(d = new Date()) {
  const x = new Date(d.getTime() + 20 * 60000);
  x.setMinutes(Math.ceil(x.getMinutes() / 5) * 5, 0, 0);
  return x;
}
