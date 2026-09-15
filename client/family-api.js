const SESSION_KEY = "family_session";

export function familyToken() {
  try {
    return localStorage.getItem(SESSION_KEY) || "";
  } catch {
    return "";
  }
}

export function setFamilyToken(token) {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode */
  }
}

async function familyFetch(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const token = familyToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  const body = await res.json().catch(() => ({ ok: false, error: "bad-json" }));
  return { status: res.status, ...body };
}

export async function familyProfiles() {
  return familyFetch("/api/family/profiles");
}

export async function familySignIn(profileId) {
  const out = await familyFetch("/api/family/session", {
    method: "POST",
    body: JSON.stringify({ profileId }),
  });
  if (out.ok && out.token) setFamilyToken(out.token);
  return out;
}

export async function familyLogout() {
  await familyFetch("/api/family/logout", { method: "POST", body: "{}" });
  setFamilyToken("");
}

export async function familyMe() {
  if (!familyToken()) return { ok: false, error: "unauthorized" };
  return familyFetch("/api/family/me");
}

export async function familyInvite() {
  return familyFetch("/api/family/invite", { method: "POST", body: "{}" });
}

export async function familyPair(code) {
  return familyFetch("/api/family/pair", { method: "POST", body: JSON.stringify({ code }) });
}

export async function familyUnlink() {
  return familyFetch("/api/family/unlink", { method: "POST", body: "{}" });
}

export async function familySetSharing(body) {
  return familyFetch("/api/family/sharing", { method: "POST", body: JSON.stringify(body) });
}

export async function familySetHome(body) {
  return familyFetch("/api/family/home", { method: "PUT", body: JSON.stringify(body) });
}

export async function familyPostLocation(point) {
  return familyFetch("/api/family/location", { method: "POST", body: JSON.stringify(point) });
}

export async function familyGetLocation() {
  return familyFetch("/api/family/location");
}

export async function familyDeleteHistory() {
  return familyFetch("/api/family/location", { method: "DELETE", body: "{}" });
}
