import { isNative } from "./native.js";

/** Native WKWebView origin is https://localhost, so family APIs must hit the VPS. */
export const FAMILY_API_NATIVE_ORIGIN = "https://smartroutine.valliani.app";

export function familyApiOrigin() {
  return isNative() ? FAMILY_API_NATIVE_ORIGIN : "";
}

let memoryToken = "";

export function familyToken() {
  return memoryToken;
}

export function setFamilyToken(token) {
  memoryToken = token || "";
}

async function familyFetch(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const token = familyToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const origin = familyApiOrigin();
  try {
    const res = await fetch(`${origin}${path}`, {
      credentials: origin ? "omit" : "same-origin",
      ...opts,
      headers,
    });
    const body = await res.json().catch(() => ({ ok: false, error: "bad-json" }));
    return { status: res.status, ...body };
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function familySignIn(username, password) {
  const out = await familyFetch("/api/family/session", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (out.ok && out.token) setFamilyToken(out.token);
  return out;
}

export async function familyLogout() {
  await familyFetch("/api/family/logout", { method: "POST", body: "{}" });
  setFamilyToken("");
}

export async function familyMe() {
  return familyFetch("/api/family/me");
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

export async function familyRegisterApns(token) {
  return familyFetch("/api/family/apns", { method: "PUT", body: JSON.stringify({ token }) });
}
