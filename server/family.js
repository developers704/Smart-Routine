import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_HOME_RADIUS_M,
  DEFAULT_MONITOR,
  LOCATION_RETENTION_DAYS,
  ROLES,
  SEED_PROFILES,
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

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function newInviteCode() {
  return randomBytes(5).toString("hex").slice(0, 8).toUpperCase();
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

export function emptyFamilyDb() {
  return {
    users: SEED_PROFILES.map((p) => ({ ...p })),
    sessions: [],
    families: [],
    locations: [],
    homes: [],
    sharing: [],
  };
}

export function createFamilyService({ now = () => Date.now(), sendPush = async () => {} } = {}) {
  let db = emptyFamilyDb();

  function persistShape() {
    return db;
  }

  function load(data) {
    db = { ...emptyFamilyDb(), ...(data || {}) };
    if (!db.users?.length) db.users = SEED_PROFILES.map((p) => ({ ...p }));
  }

  function userById(id) {
    return db.users.find((u) => u.id === id) || null;
  }

  function userFromToken(token) {
    if (!token) return null;
    const hash = hashToken(token);
    const session = db.sessions.find((s) => safeEqualHex(s.tokenHash, hash));
    if (!session) return null;
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

  function signIn(profileId) {
    const profile = db.users.find((u) => u.id === profileId);
    if (!profile) return { ok: false, error: "unknown-profile" };
    const token = newSessionToken();
    db.sessions.push({
      id: newId("ses"),
      userId: profile.id,
      tokenHash: hashToken(token),
      createdAt: new Date(now()).toISOString(),
    });
    return { ok: true, token, user: publicProfile(profile) };
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
            id: family.id,
            parentUserId: family.parentUserId,
            memberUserId: family.memberUserId,
            linked: Boolean(family.parentUserId && family.memberUserId),
          }
        : null,
      sharing: share ? { paused: Boolean(share.paused), permission: share.permission || "authorized" } : null,
    };
  }

  function createInvite(token) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    if (user.role !== ROLES.PARENT) return { ok: false, error: "forbidden" };
    let family = familyFor(user);
    if (!family) {
      family = { id: newId("fam"), parentUserId: user.id, memberUserId: null, inviteHash: null };
      db.families.push(family);
    }
    const code = newInviteCode();
    family.inviteHash = hashToken(code);
    family.inviteCreatedAt = new Date(now()).toISOString();
    return { ok: true, code, familyId: family.id };
  }

  function pair(token, code) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    if (user.role !== ROLES.MEMBER) return { ok: false, error: "forbidden" };
    const hash = hashToken(String(code || "").trim().toUpperCase());
    const family = db.families.find((f) => f.inviteHash && safeEqualHex(f.inviteHash, hash));
    if (!family) return { ok: false, error: "invalid-code" };
    if (family.memberUserId && family.memberUserId !== user.id) return { ok: false, error: "already-paired" };
    family.memberUserId = user.id;
    family.inviteHash = null;
    family.linkedAt = new Date(now()).toISOString();
    if (!db.sharing.some((s) => s.familyId === family.id)) {
      db.sharing.push({ familyId: family.id, paused: false, permission: "authorized" });
    }
    return { ok: true, familyId: family.id };
  }

  function unlink(token) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    const family = familyFor(user);
    if (!family) return { ok: false, error: "not-linked" };
    db.families = db.families.filter((f) => f.id !== family.id);
    db.sharing = db.sharing.filter((s) => s.familyId !== family.id);
    db.homes = db.homes.filter((h) => h.familyId !== family.id);
    db.locations = db.locations.filter((p) => p.familyId !== family.id);
    return { ok: true };
  }

  function setSharing(token, { paused, permission } = {}) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    if (user.role !== ROLES.MEMBER) return { ok: false, error: "forbidden" };
    const family = familyFor(user);
    if (!family?.memberUserId) return { ok: false, error: "not-linked" };
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
    let family = familyFor(user);
    if (!family) {
      family = { id: newId("fam"), parentUserId: user.id, memberUserId: null, inviteHash: null };
      db.families.push(family);
    }
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
    return { ok: true, home: row };
  }

  async function ingestLocation(token, body = {}) {
    const user = userFromToken(token);
    if (!user) return { ok: false, error: "unauthorized" };
    const family = familyFor(user);
    if (!canWriteFamilyLocation(user, family)) return { ok: false, error: "forbidden" };
    const share = sharingFor(family.id);
    if (share.paused) return { ok: false, error: "paused" };
    if (share.permission === "denied" || share.permission === "disabled") {
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
      const isHome = isAtHome(point, home, home.radiusM);
      const prev = family.lastHome === true;
      const known = family.lastHome === true || family.lastHome === false;
      const transition = geofenceTransition({
        wasHome: known ? prev : isHome ? true : false,
        isHome,
        inWindow,
      });
      // First sample inside the window: if already away, treat as away (not a false return).
      let next = transition;
      if (inWindow && family.lastHome == null && !isHome) next = "away";
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
      if (inWindow) family.lastHome = isHome;
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
    if (!family) return { ok: false, error: "not-linked" };
    if (family.parentUserId !== user.id && family.memberUserId !== user.id) {
      return { ok: false, error: "forbidden" };
    }
    db.locations = db.locations.filter((p) => p.familyId !== family.id);
    return { ok: true };
  }

  function addProfile(profile) {
    if (!profile?.id || db.users.some((u) => u.id === profile.id)) return { ok: false };
    db.users.push({ id: profile.id, name: profile.name, role: profile.role });
    return { ok: true };
  }

  return {
    persistShape,
    load,
    userFromToken,
    addProfile,
    signIn,
    signOut,
    me,
    createInvite,
    pair,
    unlink,
    setSharing,
    setHome,
    ingestLocation,
    getLocation,
    deleteLocationHistory,
    profiles: () => SEED_PROFILES.map(publicProfile),
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

export function mountFamilyRoutes(app, { limiter, service, persist }) {
  const save = async () => {
    if (persist) await persist(service);
  };

  app.get("/api/family/profiles", limiter, (_req, res) => {
    res.json({ ok: true, profiles: service.profiles() });
  });

  app.post("/api/family/session", limiter, async (req, res) => {
    const out = service.signIn(req.body?.profileId);
    if (!out.ok) {
      res.status(400).json(out);
      return;
    }
    await save();
    res.setHeader(
      "Set-Cookie",
      `family_session=${encodeURIComponent(out.token)}; Path=/; SameSite=Lax; Max-Age=2592000`
    );
    res.json(out);
  });

  app.post("/api/family/logout", limiter, async (req, res) => {
    service.signOut(familyAuthToken(req));
    await save();
    res.setHeader("Set-Cookie", "family_session=; Path=/; SameSite=Lax; Max-Age=0");
    res.json({ ok: true });
  });

  app.get("/api/family/me", limiter, (req, res) => {
    const out = service.me(familyAuthToken(req));
    res.status(out.ok ? 200 : 401).json(out);
  });

  app.post("/api/family/invite", limiter, async (req, res) => {
    const out = service.createInvite(familyAuthToken(req));
    const code = out.ok ? 200 : out.error === "unauthorized" ? 401 : 403;
    if (out.ok) await save();
    res.status(code).json(out);
  });

  app.post("/api/family/pair", limiter, async (req, res) => {
    const out = service.pair(familyAuthToken(req), req.body?.code);
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : out.error === "forbidden" ? 403 : 400;
    if (out.ok) await save();
    res.status(status).json(out);
  });

  app.post("/api/family/unlink", limiter, async (req, res) => {
    const out = service.unlink(familyAuthToken(req));
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : 400;
    if (out.ok) await save();
    res.status(status).json(out);
  });

  app.post("/api/family/sharing", limiter, async (req, res) => {
    const out = service.setSharing(familyAuthToken(req), req.body || {});
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : 403;
    if (out.ok) await save();
    res.status(status).json(out);
  });

  app.put("/api/family/home", limiter, async (req, res) => {
    const out = service.setHome(familyAuthToken(req), req.body || {});
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : out.error === "forbidden" ? 403 : 400;
    if (out.ok) await save();
    res.status(status).json(out);
  });

  app.post("/api/family/location", limiter, async (req, res) => {
    const out = await service.ingestLocation(familyAuthToken(req), req.body || {});
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : out.error === "forbidden" ? 403 : 400;
    if (out.ok) await save();
    res.status(status).json(out);
  });

  app.get("/api/family/location", limiter, (req, res) => {
    const out = service.getLocation(familyAuthToken(req));
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : 403;
    res.status(status).json(out);
  });

  app.delete("/api/family/location", limiter, async (req, res) => {
    const out = service.deleteLocationHistory(familyAuthToken(req));
    const status = out.ok ? 200 : out.error === "unauthorized" ? 401 : 400;
    if (out.ok) await save();
    res.status(status).json(out);
  });
}
