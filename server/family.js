import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_HOME_RADIUS_M,
  DEFAULT_MONITOR,
  LOCATION_RETENTION_DAYS,
  ROLES,
  SEED_ACCOUNTS,
  canReadFamilyLocation,
  canWriteFamilyLocation,
  geofenceTransition,
  homeAlertBody,
  freshnessLabel,
  homeAwayStatus,
  inMonitorWindow,
  isAtHome,
  locationFreshness,
  pruneLocationHistory,
  publicProfile,
  shouldSendHomeAlert,
  visitsAtPlaces,
} from "../client/shared/family.js";
import { writeJsonAtomic } from "./atomic-write.js";
import { dataFile } from "./paths.js";
import { hashPassword, verifyPassword } from "./password.js";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_ATTEMPTS = 8;
export const PRELINKED_FAMILY_ID = "fam_kash_anika";

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function newSessionToken() {
  return randomBytes(24).toString("hex");
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function seedUser(p) {
  return {
    id: p.id,
    username: p.username,
    name: p.name,
    role: p.role,
    passwordHash: p.passwordHash || "",
  };
}

export function emptyFamilyDb() {
  return {
    users: SEED_ACCOUNTS.map(seedUser),
    sessions: [],
    families: [
      {
        id: PRELINKED_FAMILY_ID,
        parentUserId: "user_kash",
        memberUserId: "user_anika",
        linkedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    locations: [],
    homes: [],
    sharing: [{ familyId: PRELINKED_FAMILY_ID, paused: false, permission: "authorized" }],
    apns: [],
  };
}

export function createFamilyService({
  now = () => Date.now(),
  sendPush = async () => {},
  loginMax = LOGIN_MAX_ATTEMPTS,
  loginWindowMs = LOGIN_WINDOW_MS,
  sessionTtlMs = SESSION_TTL_MS,
} = {}) {
  let db = emptyFamilyDb();
  const loginHits = new Map();

  function persistShape() {
    return db;
  }

  function load(data) {
    db = { ...emptyFamilyDb(), ...(data || {}) };
    if (!db.users?.length) db.users = SEED_ACCOUNTS.map(seedUser);
    for (const seed of SEED_ACCOUNTS) {
      if (!db.users.some((u) => u.id === seed.id)) db.users.push(seedUser(seed));
    }
    if (!db.apns) db.apns = [];
    ensurePreLinked();
  }

  function ensurePreLinked() {
    let family = db.families.find((f) => f.id === PRELINKED_FAMILY_ID);
    if (!family) {
      family = {
        id: PRELINKED_FAMILY_ID,
        parentUserId: "user_kash",
        memberUserId: "user_anika",
        linkedAt: new Date(now()).toISOString(),
      };
      db.families.push(family);
    }
    family.parentUserId = "user_kash";
    family.memberUserId = "user_anika";
    if (!db.sharing.some((s) => s.familyId === family.id)) {
      db.sharing.push({ familyId: family.id, paused: false, permission: "authorized" });
    }
  }

  function userById(id) {
    return db.users.find((u) => u.id === id) || null;
  }

  function userFromToken(token) {
    if (!token) return null;
    const hash = hashToken(token);
    const session = db.sessions.find((s) => safeEqualHex(s.tokenHash, hash));
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= now()) return null;
    return userById(session.userId);
  }

  function familyFor(user) {
    if (!user) return null;
    return (
      db.families.find((f) => f.parentUserId === user.id || f.memberUserId === user.id) || null
    );
  }

  function sharingFor(familyId) {
    return db.sharing.find((s) => s.familyId === familyId) || { familyId, paused: false, permission: "authorized" };
  }

  function homeFor(familyId) {
    return db.homes.find((h) => h.familyId === familyId) || null;
  }

  function loginAllowed(key) {
    const entry = loginHits.get(key);
    const t = now();
    if (!entry || t - entry.start >= loginWindowMs) {
      loginHits.set(key, { start: t, count: 1 });
      return true;
    }
    if (entry.count >= loginMax) return false;
    entry.count++;
    return true;
  }

  async function signIn({ username, password, ip } = {}) {
    const userKey = String(username || "").trim().toLowerCase();
    const key = `${ip || "ip"}:${userKey || "unknown"}`;
    if (!loginAllowed(key)) return { ok: false, error: "rate-limited" };
    const user = db.users.find((u) => String(u.username || "").toLowerCase() === userKey);
    const stored = user?.passwordHash || "";
    const ok = await verifyPassword(password, stored);
    if (!user || !stored || !ok) return { ok: false, error: "unauthorized" };
    const token = newSessionToken();
    const createdAt = new Date(now()).toISOString();
    db.sessions.push({
      id: newId("ses"),
      userId: user.id,
      tokenHash: hashToken(token),
      createdAt,
      expiresAt: new Date(now() + sessionTtlMs).toISOString(),
    });
    return { ok: true, token, expiresAt: new Date(now() + sessionTtlMs).toISOString(), user: publicProfile(user) };
  }

  function signOut(token) {
    const hash = hashToken(token || "");
    db.sessions = db.sessions.filter((s) => !safeEqualHex(s.tokenHash, hash));
    return { ok: true };
  }

  function me(token) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    const family = familyFor(user);
    const share = family ? sharingFor(family.id) : null;
    return {
      ok: true,
      user: publicProfile(user),
      family: family
        ? {
            linked: Boolean(family.parentUserId && family.memberUserId),
          }
        : null,
      sharing: share ? { paused: Boolean(share.paused), permission: share.permission || "authorized" } : null,
    };
  }

  function setSharing(token, { paused, permission } = {}) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    if (user.role !== ROLES.MEMBER) return { ok: false, error: "forbidden" };
    const family = familyFor(user);
    if (!family?.memberUserId) return { ok: false, error: "forbidden" };
    let row = db.sharing.find((s) => s.familyId === family.id);
    if (!row) {
      row = { familyId: family.id, paused: false, permission: "authorized" };
      db.sharing.push(row);
    }
    if (paused != null) row.paused = Boolean(paused);
    if (permission) row.permission = permission;
    return { ok: true, paused: row.paused, permission: row.permission };
  }

  function setHome(token, body = {}) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    if (user.role !== ROLES.PARENT) return { ok: false, error: "forbidden" };
    const family = familyFor(user);
    if (!family?.memberUserId) return { ok: false, error: "forbidden" };
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: "invalid-home" };
    const radiusM = Math.max(40, Number(body.radiusM) || DEFAULT_HOME_RADIUS_M);
    const startMin = Number.isFinite(Number(body.startMin)) ? Number(body.startMin) : DEFAULT_MONITOR.startMin;
    const endMin = Number.isFinite(Number(body.endMin)) ? Number(body.endMin) : DEFAULT_MONITOR.endMin;
    let row = db.homes.find((h) => h.familyId === family.id);
    if (!row) {
      row = { familyId: family.id };
      db.homes.push(row);
    }
    Object.assign(row, { lat, lng, radiusM, startMin, endMin, name: body.name || "Home" });
    return { ok: true, home: { lat, lng, radiusM, startMin, endMin, name: row.name } };
  }

  async function ingestLocation(token, body = {}) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    const family = familyFor(user);
    if (!canWriteFamilyLocation(user, family)) return { ok: false, error: "forbidden" };
    const share = sharingFor(family.id);
    if (share.paused) return { ok: false, error: "paused" };
    if (share.permission === "denied" || share.permission === "disabled" || share.permission === "offline") {
      return { ok: false, error: share.permission };
    }
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: "invalid-point" };
    const at = body.at || new Date(now()).toISOString();
    const point = {
      id: newId("loc"),
      familyId: family.id,
      memberUserId: user.id,
      lat,
      lng,
      accuracy: Number.isFinite(Number(body.accuracy)) ? Number(body.accuracy) : null,
      at,
    };
    db.locations.push(point);
    db.locations = pruneLocationHistory(db.locations, now(), LOCATION_RETENTION_DAYS);

    const home = homeFor(family.id);
    let alert = null;
    if (home) {
      const t = new Date(at);
      const inWindow = inMonitorWindow(t, home);
      const isHomeNow = isAtHome(point, home, home.radiusM);
      const prev = family.lastHome === true;
      const known = family.lastHome === true || family.lastHome === false;
      const transition = geofenceTransition({
        wasHome: known ? prev : isHomeNow ? true : false,
        isHome: isHomeNow,
        inWindow,
      });
      let next = transition;
      if (inWindow && family.lastHome == null && !isHomeNow) next = "away";
      if (inWindow && shouldSendHomeAlert(family.lastAlert, next)) {
        family.lastAlert = next;
        family.lastAlertAt = at;
        alert = {
          kind: next,
          title: next === "returned" ? "Returned home" : "Away from home",
          body: homeAlertBody({ memberName: user.name, kind: next, at }),
        };
        await sendPush({ userId: family.parentUserId, payload: alert });
      }
      if (inWindow) family.lastHome = isHomeNow;
    }
    return { ok: true, id: point.id, alert: alert?.kind || null };
  }

  function getLocation(token) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    const family = familyFor(user);
    if (!canReadFamilyLocation(user, family)) return { ok: false, error: "forbidden" };
    const share = sharingFor(family.id);
    const points = db.locations.filter((p) => p.familyId === family.id);
    const latest = points.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || null;
    const freshness = locationFreshness(latest?.at, now(), {
      paused: share.paused,
      permission: share.permission,
    });
    const home = homeFor(family.id);
    const status = homeAwayStatus(latest, home, home?.radiusM, freshness);
    const start = new Date(now());
    start.setHours(0, 0, 0, 0);
    const end = start.getTime() + 24 * 60 * 60 * 1000;
    const today = points
      .filter((p) => {
        const t = Date.parse(p.at);
        return t >= start.getTime() && t < end;
      })
      .map((p) => ({ lat: p.lat, lng: p.lng, accuracy: p.accuracy, at: p.at }));
    const places = home ? [{ ...home, id: "home" }] : [];
    return {
      ok: true,
      freshness,
      freshnessLabel: freshnessLabel(freshness),
      live: false,
      status,
      updatedAt: latest?.at || null,
      lastAlert: family.lastAlert || null,
      lastAlertAt: family.lastAlertAt || null,
      current:
        latest && freshness !== "paused"
          ? { lat: latest.lat, lng: latest.lng, at: latest.at, accuracy: latest.accuracy }
          : null,
      today,
      visits: visitsAtPlaces(today, places, start.getTime(), end),
      sharing: { paused: Boolean(share.paused), permission: share.permission || "authorized" },
      home: home
        ? { lat: home.lat, lng: home.lng, radiusM: home.radiusM, startMin: home.startMin, endMin: home.endMin, name: home.name || "Home" }
        : null,
    };
  }

  function deleteLocationHistory(token) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    const family = familyFor(user);
    if (!family) return { ok: false, error: "forbidden" };
    if (family.parentUserId !== user.id && family.memberUserId !== user.id) {
      return { ok: false, error: "forbidden" };
    }
    db.locations = db.locations.filter((p) => p.familyId !== family.id);
    return { ok: true };
  }

  function registerApns(token, deviceToken) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    const value = String(deviceToken || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64,200}$/.test(value)) return { ok: false, error: "invalid-token" };
    db.apns = db.apns.filter((row) => row.token !== value);
    db.apns.push({ userId: user.id, token: value, updatedAt: new Date(now()).toISOString() });
    return { ok: true };
  }

  function listApnsForUser(userId) {
    return db.apns.filter((row) => row.userId === userId).map((row) => row.token);
  }

  function removeApnsToken(deviceToken) {
    const value = String(deviceToken || "").trim().toLowerCase();
    const before = db.apns.length;
    db.apns = db.apns.filter((row) => row.token !== value);
    return before !== db.apns.length;
  }

  function addAccount(account) {
    if (!account?.id || db.users.some((u) => u.id === account.id)) return { ok: false };
    db.users.push({
      id: account.id,
      username: account.username,
      name: account.name,
      role: account.role,
      passwordHash: account.passwordHash || "",
    });
    return { ok: true };
  }

  async function setPasswordHash(userId, password) {
    const user = userById(userId);
    if (!user) return { ok: false, error: "unknown-user" };
    const hashed = await hashPassword(password);
    if (!hashed.ok) return hashed;
    user.passwordHash = hashed.hash;
    return { ok: true };
  }

  function applyPasswordHash(userId, passwordHash) {
    const user = userById(userId);
    if (!user || !passwordHash) return { ok: false };
    user.passwordHash = passwordHash;
    return { ok: true };
  }

  ensurePreLinked();

  return {
    persistShape,
    load,
    userFromToken,
    addAccount,
    setPasswordHash,
    applyPasswordHash,
    signIn,
    signOut,
    me,
    setSharing,
    setHome,
    ingestLocation,
    getLocation,
    deleteLocationHistory,
    registerApns,
    listApnsForUser,
    removeApnsToken,
    ensurePreLinked,
  };
}

function familyFile() {
  return dataFile("family.json");
}

let diskService = null;

export async function loadFamilyService(opts = {}) {
  const service = createFamilyService(opts);
  try {
    const raw = await readFile(familyFile(), "utf8");
    service.load(JSON.parse(raw));
  } catch {
    /* first run */
  }
  service.applyPasswordHash("user_kash", process.env.FAMILY_KASH_PASSWORD_HASH || "");
  service.applyPasswordHash("user_anika", process.env.FAMILY_ANIKA_PASSWORD_HASH || "");
  service.ensurePreLinked();
  diskService = service;
  return service;
}

export async function persistFamilyService(service = diskService) {
  if (!service) return;
  await writeJsonAtomic(familyFile(), service.persistShape());
}

export function familyAuthToken(req) {
  const header = req.headers?.authorization || "";
  const m = /^Bearer\s+(\S+)/i.exec(header);
  if (m) return m[1];
  const cookie = req.headers?.cookie || "";
  const hit = cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith("family_session="));
  return hit ? decodeURIComponent(hit.slice("family_session=".length)) : "";
}

export function mountFamilyRoutes(app, { limiter, loginLimiter, service, persist }) {
  const save = async () => {
    if (persist) await persist(service);
  };
  const gate = limiter;
  const loginGate = loginLimiter || limiter;

  app.post("/api/family/session", loginGate, async (req, res) => {
    if (req.body?.role || req.body?.profileId) {
      res.status(400).json({ ok: false, error: "invalid-login" });
      return;
    }
    const out = await service.signIn({
      username: req.body?.username,
      password: req.body?.password,
      ip: req.ip,
    });
    if (!out.ok) {
      res.status(out.error === "rate-limited" ? 429 : 401).json({ ok: false, error: out.error });
      return;
    }
    await save();
    res.setHeader(
      "Set-Cookie",
      `family_session=${encodeURIComponent(out.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    );
    res.json({ ok: true, token: out.token, expiresAt: out.expiresAt, user: out.user });
  });

  app.post("/api/family/logout", gate, async (req, res) => {
    service.signOut(familyAuthToken(req));
    await save();
    res.setHeader("Set-Cookie", "family_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    res.json({ ok: true });
  });

  app.get("/api/family/me", gate, (req, res) => {
    const out = service.me(familyAuthToken(req));
    res.status(out.ok ? 200 : 401).json(out);
  });

  app.post("/api/family/sharing", gate, async (req, res) => {
    const out = service.setSharing(familyAuthToken(req), req.body || {});
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : 403;
    if (out.ok) await save();
    res.status(status).json(out);
  });

  app.put("/api/family/home", gate, async (req, res) => {
    const out = service.setHome(familyAuthToken(req), req.body || {});
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : out.error === "forbidden" ? 403 : 400;
    if (out.ok) await save();
    res.status(status).json(out);
  });

  app.post("/api/family/location", gate, async (req, res) => {
    const out = await service.ingestLocation(familyAuthToken(req), req.body || {});
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : out.error === "forbidden" ? 403 : 400;
    if (out.ok) await save();
    res.status(status).json(out);
  });

  app.get("/api/family/location", gate, (req, res) => {
    const out = service.getLocation(familyAuthToken(req));
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : 403;
    res.status(status).json(out);
  });

  app.delete("/api/family/location", gate, async (req, res) => {
    const out = service.deleteLocationHistory(familyAuthToken(req));
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : 403;
    if (out.ok) await save();
    res.status(status).json(out);
  });

  app.put("/api/family/apns", gate, async (req, res) => {
    const out = service.registerApns(familyAuthToken(req), req.body?.token);
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : 400;
    if (out.ok) await save();
    res.status(status).json(out);
  });
}
