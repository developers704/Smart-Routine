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
  familyMemberIds,
  geofenceTransition,
  homeAlertBody,
  freshnessLabel,
  homeAwayStatus,
  inMonitorWindow,
  isAtHome,
  locationFreshness,
  minutesFromMidnight,
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

/**
 * Temporary test hashes for password "123456" on both seed accounts.
 * Override with FAMILY_KASH_PASSWORD_HASH / FAMILY_ANIKA_PASSWORD_HASH.
 */
export const TEST_FAMILY_PASSWORD_HASHES = {
  user_kash: "scrypt$16384$8$1$88zMaUYCy+6ktyj8kgmGcw==$ymcKRqScL64DLg8/rSWlfku0XE3DYIQ6zp8kob8Nqug=",
  user_anika: "scrypt$16384$8$1$uYZTbmOZjJ65j30SzjOQWA==$l7UFynlZQ//XTTdZWRL6GMFSQS4K/eawFu0XfO+8BqU=",
  user_owais: "scrypt$16384$8$1$p/ecRUgZY7FkZ7+5SZA0ZA==$aiOl2aqXpT25hf9dPjdm1GgFFhHnOCcsHQjaMRLpAME=",
};

export function familyPasswordHashFromEnv(userId, env = process.env) {
  const fallback = TEST_FAMILY_PASSWORD_HASHES[userId] || "";
  if (userId === "user_kash") return String(env.FAMILY_KASH_PASSWORD_HASH || "").trim() || fallback;
  if (userId === "user_anika") return String(env.FAMILY_ANIKA_PASSWORD_HASH || "").trim() || fallback;
  if (userId === "user_owais") return String(env.FAMILY_OWAIS_PASSWORD_HASH || "").trim() || fallback;
  return fallback;
}

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
    presence: [],
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
    if (!db.presence) db.presence = [];
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
    family.memberIds = ["user_anika", "user_owais"];
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
      db.families.find((f) => f.parentUserId === user.id || familyMemberIds(f).includes(user.id)) || null
    );
  }

  function sharingFor(familyId) {
    return db.sharing.find((s) => s.familyId === familyId) || { familyId, paused: false, permission: "authorized" };
  }

  function homeFor(family, memberId) {
    const id = memberId || family.memberUserId;
    return (
      db.homes.find(
        (h) => h.familyId === family.id && (h.memberUserId === id || (!h.memberUserId && id === family.memberUserId))
      ) || null
    );
  }

  function memberTrack(family, memberId) {
    if (!family.tracks) family.tracks = {};
    if (!family.tracks[memberId]) {
      family.tracks[memberId] =
        memberId === family.memberUserId
          ? { lastHome: family.lastHome, lastAlert: family.lastAlert, lastAlertAt: family.lastAlertAt }
          : {};
    }
    return family.tracks[memberId];
  }

  function writeTrack(family, memberId, track) {
    if (!family.tracks) family.tracks = {};
    family.tracks[memberId] = track;
    if (memberId === family.memberUserId) {
      family.lastHome = track.lastHome;
      family.lastAlert = track.lastAlert;
      family.lastAlertAt = track.lastAlertAt;
    }
  }

  function resolveMember(family, memberKey) {
    const ids = familyMemberIds(family);
    if (!memberKey) return family.memberUserId;
    const key = String(memberKey).trim().toLowerCase();
    const user = db.users.find((u) => ids.includes(u.id) && (u.id === memberKey || String(u.username || "").toLowerCase() === key));
    return user?.id || null;
  }

  function memberRoster(family) {
    return familyMemberIds(family)
      .map((id) => userById(id))
      .filter(Boolean)
      .map((u) => ({ id: u.id, username: u.username, name: u.name }));
  }

  function pointsFor(family, memberId) {
    return db.locations.filter(
      (p) => p.familyId === family.id && (p.memberUserId === memberId || (!p.memberUserId && memberId === family.memberUserId))
    );
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

  async function emitHomeAlert(family, memberId, memberName, next, at) {
    const track = memberTrack(family, memberId);
    writeTrack(family, memberId, { ...track, lastAlert: next, lastAlertAt: at });
    const alert = {
      kind: next,
      title: next === "returned" ? "Returned home" : "Away from home",
      body: homeAlertBody({ memberName, kind: next, at }),
    };
    await sendPush({ userId: family.parentUserId, payload: alert });
    return alert;
  }

  async function setHome(token, body = {}) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    if (user.role !== ROLES.PARENT) return { ok: false, error: "forbidden" };
    const family = familyFor(user);
    if (!family?.memberUserId) return { ok: false, error: "forbidden" };
    const memberId = resolveMember(family, body.member);
    if (!memberId) return { ok: false, error: "unknown-member" };
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: "invalid-home" };
    const radiusM = Math.max(40, Number(body.radiusM) || DEFAULT_HOME_RADIUS_M);
    const startMin = minutesFromMidnight(body.startMin, DEFAULT_MONITOR.startMin);
    const endMin = minutesFromMidnight(body.endMin, DEFAULT_MONITOR.endMin);
    let row = homeFor(family, memberId);
    if (!row) {
      row = { familyId: family.id, memberUserId: memberId };
      db.homes.push(row);
    }
    row.memberUserId = memberId;
    const prev =
      row.lat != null && row.lng != null
        ? { lat: row.lat, lng: row.lng, radiusM: row.radiusM || DEFAULT_HOME_RADIUS_M }
        : null;
    Object.assign(row, { lat, lng, radiusM, startMin, endMin, name: body.name || "Home" });

    let alert = null;
    const share = sharingFor(family.id);
    const latest = pointsFor(family, memberId)
      .slice()
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const track = memberTrack(family, memberId);
    const sharingOn =
      latest &&
      !share.paused &&
      share.permission !== "denied" &&
      share.permission !== "disabled" &&
      share.permission !== "offline";
    if (sharingOn) {
      const inWindow = inMonitorWindow(new Date(now()), row);
      const wasInside = prev ? isAtHome(latest, prev, prev.radiusM) : track.lastHome === true;
      const isInside = isAtHome(latest, row, row.radiusM);
      const next = geofenceTransition({
        wasHome: wasInside,
        isHome: isInside,
        inWindow,
      });
      if (inWindow && shouldSendHomeAlert(track.lastAlert, next)) {
        const member = userById(memberId);
        alert = await emitHomeAlert(family, memberId, member?.name || "Anika", next, latest.at);
      }
      if (inWindow) {
        const fresh = memberTrack(family, memberId);
        writeTrack(family, memberId, { ...fresh, lastHome: isInside });
      }
    }
    return {
      ok: true,
      member: memberId,
      home: { lat, lng, radiusM, startMin, endMin, name: row.name },
      alert: alert?.kind || null,
    };
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

    const home = homeFor(family, user.id);
    let alert = null;
    if (home) {
      const track = memberTrack(family, user.id);
      const t = new Date(at);
      const inWindow = inMonitorWindow(t, home);
      const isHomeNow = isAtHome(point, home, home.radiusM);
      const prev = track.lastHome === true;
      const known = track.lastHome === true || track.lastHome === false;
      const transition = geofenceTransition({
        wasHome: known ? prev : isHomeNow ? true : false,
        isHome: isHomeNow,
        inWindow,
      });
      let next = transition;
      if (inWindow && track.lastHome == null && !isHomeNow) next = "away";
      if (inWindow && shouldSendHomeAlert(track.lastAlert, next)) {
        alert = await emitHomeAlert(family, user.id, user.name, next, at);
      }
      if (inWindow) {
        const fresh = memberTrack(family, user.id);
        writeTrack(family, user.id, { ...fresh, lastHome: isHomeNow });
      }
    }
    return { ok: true, id: point.id, alert: alert?.kind || null };
  }

  function getLocation(token, memberKey) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    const family = familyFor(user);
    if (!canReadFamilyLocation(user, family)) return { ok: false, error: "forbidden" };
    const memberId = resolveMember(family, memberKey);
    if (!memberId) return { ok: false, error: "unknown-member" };
    const member = userById(memberId);
    const share = sharingFor(family.id);
    const points = pointsFor(family, memberId);
    const latest = points.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || null;
    const freshness = locationFreshness(latest?.at, now(), {
      paused: share.paused,
      permission: share.permission,
    });
    const home = homeFor(family, memberId);
    const track = memberTrack(family, memberId);
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
    const presence = presenceList().filter((p) => p.username === member?.username);
    return {
      ok: true,
      freshness,
      freshnessLabel: freshnessLabel(freshness),
      live: false,
      status,
      updatedAt: latest?.at || null,
      lastAlert: track.lastAlert || null,
      lastAlertAt: track.lastAlertAt || null,
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
      presence,
      members: memberRoster(family),
      member: member ? { id: member.id, username: member.username, name: member.name } : null,
    };
  }

  function pulse(token, platform) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    const at = new Date(now()).toISOString();
    let row = db.presence.find((p) => p.userId === user.id);
    const fresh = row && now() - Date.parse(row.lastSeen) < 2 * 60 * 1000;
    if (!row) {
      row = { userId: user.id, since: at, lastSeen: at, platform: platform || "Web" };
      db.presence.push(row);
    } else {
      const nextPlatform = platform || row.platform || "Web";
      if (!fresh || nextPlatform !== row.platform) row.since = at;
      row.lastSeen = at;
      row.platform = nextPlatform;
    }
    return { ok: true, since: row.since, platform: row.platform };
  }

  function presenceList() {
    return (db.presence || [])
      .map((row) => {
        const user = userById(row.userId);
        const age = now() - Date.parse(row.lastSeen);
        return {
          username: user?.username || "",
          name: user?.name || "",
          platform: row.platform || "Web",
          since: row.since,
          lastSeen: row.lastSeen,
          online: age >= 0 && age < 90 * 1000,
        };
      })
      .filter((p) => p.username && p.username !== "kash");
  }

  function deleteLocationHistory(token, memberKey) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    const family = familyFor(user);
    if (!family) return { ok: false, error: "forbidden" };
    let memberId = null;
    if (user.role === ROLES.PARENT) {
      if (family.parentUserId !== user.id) return { ok: false, error: "forbidden" };
      memberId = resolveMember(family, memberKey);
      if (!memberId) return { ok: false, error: "unknown-member" };
    } else if (familyMemberIds(family).includes(user.id)) {
      memberId = user.id;
    } else {
      return { ok: false, error: "forbidden" };
    }
    db.locations = db.locations.filter((p) => {
      if (p.familyId !== family.id) return true;
      const owner = p.memberUserId || family.memberUserId;
      return owner !== memberId;
    });
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

  async function changePassword(token, currentPassword, newPassword) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    const matches = await verifyPassword(String(currentPassword || ""), user.passwordHash || "");
    if (!matches) return { ok: false, error: "wrong-password" };
    return setPasswordHash(user.id, newPassword);
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
    changePassword,
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
    pulse,
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
  service.applyPasswordHash("user_kash", familyPasswordHashFromEnv("user_kash"));
  service.applyPasswordHash("user_anika", familyPasswordHashFromEnv("user_anika"));
  service.applyPasswordHash("user_owais", familyPasswordHashFromEnv("user_owais"));
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

  app.post("/api/family/password", gate, async (req, res) => {
    const out = await service.changePassword(
      familyAuthToken(req),
      req.body?.currentPassword,
      req.body?.newPassword
    );
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : 400;
    if (out.ok) await save();
    res.status(status).json(out.ok ? { ok: true } : { ok: false, error: out.error });
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
    const out = await service.setHome(familyAuthToken(req), req.body || {});
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
    const out = service.getLocation(familyAuthToken(req), req.query.member);
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : out.error === "unknown-member" ? 400 : 403;
    res.status(status).json(out);
  });

  app.delete("/api/family/location", gate, async (req, res) => {
    const out = service.deleteLocationHistory(familyAuthToken(req), req.query.member);
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : out.error === "unknown-member" ? 400 : 403;
    if (out.ok) await save();
    res.status(status).json(out);
  });

  app.post("/api/family/presence", gate, async (req, res) => {
    const out = service.pulse(familyAuthToken(req), req.body?.platform);
    const status = out.ok ? 200 : 401;
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
