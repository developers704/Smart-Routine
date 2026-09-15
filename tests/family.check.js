import {
  DEFAULT_MONITOR,
  ROLES,
  SEED_PROFILES,
  STALE_AFTER_MS,
  UNAVAILABLE_AFTER_MS,
  canReadFamilyLocation,
  canWriteFamilyLocation,
  freshnessLabel,
  geofenceTransition,
  haversineMeters,
  homeAlertBody,
  homeAwayStatus,
  inMonitorWindow,
  isAtHome,
  locationFreshness,
  pruneLocationHistory,
  shouldSendHomeAlert,
  visitsAtPlaces,
} from "../client/shared/family.js";
import { createFamilyService, mountFamilyRoutes } from "../server/family.js";
import express from "express";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

assert(SEED_PROFILES.some((p) => p.name === "Kash Valliani" && p.role === ROLES.PARENT), "Kash is the parent seed");
assert(SEED_PROFILES.some((p) => p.name === "Anika" && p.role === ROLES.MEMBER), "Anika is the member seed");

const now = Date.parse("2026-09-15T08:00:00Z");
assert(locationFreshness(new Date(now - 60_000).toISOString(), now) === "accurate", "Fresh fix is accurate");
assert(locationFreshness(new Date(now - STALE_AFTER_MS - 1000).toISOString(), now) === "stale", "Old fix is stale");
assert(
  locationFreshness(new Date(now - UNAVAILABLE_AFTER_MS - 1000).toISOString(), now) === "unavailable",
  "Very old fix is unavailable"
);
assert(locationFreshness(new Date(now - 1000).toISOString(), now, { paused: true }) === "paused", "Paused sharing");
assert(locationFreshness(new Date(now - 1000).toISOString(), now, { permission: "denied" }) === "denied", "Denied permission");
assert(locationFreshness(new Date(now - 1000).toISOString(), now, { permission: "disabled" }) === "disabled", "Location off");
assert(freshnessLabel("accurate") === "Updated", "Accurate is labeled Updated, not Live");
assert(!/live/i.test(freshnessLabel("accurate")), "Never says Live");
assert(freshnessLabel("stale") === "Stale", "Stale label");

const home = { lat: 42.3468, lng: -71.1039 };
assert(isAtHome({ lat: 42.3468, lng: -71.1039 }, home, 150), "At home");
assert(!isAtHome({ lat: 42.36, lng: -71.06 }, home, 150), "Downtown is away");
assert(haversineMeters(home, home) < 1, "Zero distance at same point");

assert(inMonitorWindow(new Date(2026, 8, 15, 0, 30), DEFAULT_MONITOR), "12:30 AM is in the default window");
assert(inMonitorWindow(new Date(2026, 8, 15, 4, 59), DEFAULT_MONITOR), "4:59 AM is in the default window");
assert(!inMonitorWindow(new Date(2026, 8, 15, 5, 0), DEFAULT_MONITOR), "5:00 AM is outside the default window");
assert(!inMonitorWindow(new Date(2026, 8, 15, 12, 0), DEFAULT_MONITOR), "Noon is outside the window");

assert(geofenceTransition({ wasHome: true, isHome: false, inWindow: true }) === "away", "Leave home → away");
assert(geofenceTransition({ wasHome: false, isHome: true, inWindow: true }) === "returned", "Enter home → returned");
assert(geofenceTransition({ wasHome: true, isHome: false, inWindow: false }) === null, "No alert outside the window");
assert(shouldSendHomeAlert(null, "away"), "First away alerts");
assert(!shouldSendHomeAlert("away", "away"), "Duplicate away is suppressed");
assert(shouldSendHomeAlert("away", "returned"), "Returned after away alerts once");
assert(!shouldSendHomeAlert("returned", "returned"), "Duplicate returned is suppressed");
assert(shouldSendHomeAlert("returned", "away"), "A later away after returned alerts again");

assert(homeAwayStatus({ lat: 42.3468, lng: -71.1039 }, home, 150, "accurate") === "home", "Home status");
assert(homeAwayStatus({ lat: 42.36, lng: -71.06 }, home, 150, "accurate") === "away", "Away status");
assert(homeAwayStatus({ lat: 42.36, lng: -71.06 }, home, 150, "unavailable") === "unknown", "Unavailable hides home/away");

const visits = visitsAtPlaces(
  [
    { lat: 42.3468, lng: -71.1039, at: "2026-09-15T01:00:00" },
    { lat: 42.3468, lng: -71.1039, at: "2026-09-15T02:00:00" },
    { lat: 42.36, lng: -71.06, at: "2026-09-15T03:00:00" },
  ],
  [{ id: "home", name: "Home", lat: 42.3468, lng: -71.1039, radiusM: 150 }],
  Date.parse("2026-09-15T00:00:00"),
  Date.parse("2026-09-16T00:00:00")
);
assert(visits[0]?.arrivedAt === "2026-09-15T01:00:00", "Arrival time at home");
assert(visits[0]?.departedAt === "2026-09-15T03:00:00", "Departure time from home");
assert(visits[0]?.durationMin === 120, "Estimated duration at home");

const pruned = pruneLocationHistory(
  [{ at: new Date(now - 20 * 86400000).toISOString() }, { at: new Date(now - 86400000).toISOString() }],
  now,
  14
);
assert(pruned.length === 1, "Location history older than retention is dropped");

const body = homeAlertBody({ memberName: "Anika", kind: "away", at: "2026-09-15T01:10:00.000Z" });
assert(body.includes("2026-09-15T01:10:00.000Z"), "Alert includes the location timestamp");
assert(/not an alarm/i.test(body), "Alert does not claim to be an alarm");
assert(/Silent or Focus/i.test(body), "Alert admits Silent/Focus may block it");

const famA = { id: "fam_a", parentUserId: "user_kash", memberUserId: "user_anika" };
const famB = { id: "fam_b", parentUserId: "user_other", memberUserId: "user_kid" };
assert(
  canReadFamilyLocation({ id: "user_kash", role: ROLES.PARENT }, famA),
  "Kash can read Anika’s family"
);
assert(
  !canReadFamilyLocation({ id: "user_other", role: ROLES.PARENT }, famA),
  "Another parent cannot read Kash’s family"
);
assert(!canWriteFamilyLocation({ id: "user_kash", role: ROLES.PARENT }, famA), "Parent cannot post member location");
assert(canWriteFamilyLocation({ id: "user_anika", role: ROLES.MEMBER }, famA), "Anika can post her location");
assert(!canReadFamilyLocation({ id: "user_kash", role: ROLES.PARENT }, famB), "Kash cannot read another family’s data");

let clock = Date.parse("2026-09-15T01:00:00");
const pushes = [];
const svc = createFamilyService({
  now: () => clock,
  sendPush: async (msg) => {
    pushes.push(msg);
  },
});

const kash = svc.signIn("user_kash");
const anika = svc.signIn("user_anika");
assert(kash.ok && kash.token && kash.token !== "kash", "Kash session is a random token, not a hardcoded password");
assert(anika.ok && anika.user.role === "member", "Anika signs in as member");
assert(svc.signIn("nope").error === "unknown-profile", "Unknown profiles are rejected");

assert(svc.me("").error === "unauthorized", "Missing session is unauthorized");
assert(svc.createInvite(anika.token).error === "forbidden", "Member cannot mint a parent invite");
const invite = svc.createInvite(kash.token);
assert(invite.ok && invite.code.length >= 6, "Parent gets a pairing code");
assert(svc.pair(kash.token, invite.code).error === "forbidden", "Parent cannot redeem the member code");
assert(svc.pair(anika.token, "NOPE").error === "invalid-code", "Bad code fails");
assert(svc.pair(anika.token, invite.code).ok, "Anika pairs with Kash");

const other = createFamilyService({ now: () => clock });
const kash2 = other.signIn("user_kash");
other.createInvite(kash2.token);
assert(other.getLocation(kash2.token).error === "forbidden", "Unlinked parent has no member location");

assert(svc.getLocation(anika.token).error === "forbidden", "Member cannot read the parent location feed");
assert((await svc.ingestLocation(kash.token, { lat: 1, lng: 1 })).error === "forbidden", "Parent cannot spoof member GPS");

svc.setHome(kash.token, { lat: 42.3468, lng: -71.1039, radiusM: 150, startMin: 0, endMin: 5 * 60 });

clock = Date.parse("2026-09-15T01:10:00");
const away = await svc.ingestLocation(anika.token, { lat: 42.36, lng: -71.06, at: new Date(clock).toISOString() });
assert(away.ok && away.alert === "away", "First overnight away sends one alert");
assert(pushes.length === 1 && pushes[0].userId === "user_kash", "Alert goes to Kash, not Anika");

clock = Date.parse("2026-09-15T01:20:00");
const away2 = await svc.ingestLocation(anika.token, { lat: 42.361, lng: -71.061, at: new Date(clock).toISOString() });
assert(away2.ok && away2.alert == null, "Still away does not re-alert");
assert(pushes.length === 1, "No duplicate away push");

clock = Date.parse("2026-09-15T02:00:00");
const homeFix = await svc.ingestLocation(anika.token, { lat: 42.3468, lng: -71.1039, at: new Date(clock).toISOString() });
assert(homeFix.alert === "returned", "Returned home sends one update");
assert(pushes.length === 2, "Returned is a second, different alert");

clock = Date.parse("2026-09-15T12:00:00");
const noon = await svc.ingestLocation(anika.token, { lat: 42.36, lng: -71.06, at: new Date(clock).toISOString() });
assert(noon.alert == null, "Away at noon does not use the overnight geofence");

svc.setSharing(anika.token, { paused: true });
clock = Date.parse("2026-09-15T01:40:00");
const paused = await svc.ingestLocation(anika.token, { lat: 42.36, lng: -71.06, at: new Date(clock).toISOString() });
assert(paused.error === "paused", "Paused sharing rejects location writes");

svc.setSharing(anika.token, { paused: false, permission: "denied" });
const denied = await svc.ingestLocation(anika.token, { lat: 42.36, lng: -71.06 });
assert(denied.error === "denied", "Denied permission rejects location writes");

svc.setSharing(anika.token, { permission: "authorized" });
const feed = svc.getLocation(kash.token);
assert(feed.ok && feed.freshness, "Kash can read Anika’s location");
assert(feed.live === false, "API never claims Live");
assert(feed.today.length >= 1, "Today’s history is included");

svc.addProfile({ id: "user_other", name: "Other Dad", role: ROLES.PARENT });
svc.addProfile({ id: "user_kid", name: "Kid", role: ROLES.MEMBER });
const otherDad = svc.signIn("user_other");
const kid = svc.signIn("user_kid");
const inviteB = svc.createInvite(otherDad.token);
assert(svc.pair(kid.token, inviteB.code).ok, "Second family can pair independently");
clock = Date.parse("2026-09-15T13:00:00");
await svc.ingestLocation(kid.token, { lat: 40.7, lng: -74.0, at: new Date(clock).toISOString() });
const feedA = svc.getLocation(kash.token);
const feedB = svc.getLocation(otherDad.token);
assert(feedA.current && Math.abs(feedA.current.lat - 40.7) > 0.5, "Kash does not see the other child’s coordinates");
assert(feedB.current && Math.abs(feedB.current.lat - 40.7) < 0.01, "Other dad sees only his child");
assert(svc.getLocation(kid.token).error === "forbidden", "Child cannot read the parent feed");

assert(svc.deleteLocationHistory(kash.token).ok, "Parent can delete location history");
assert(svc.getLocation(kash.token).today.length === 0, "History deletion clears points");
assert(svc.unlink(anika.token).ok, "Anika can remove the parent link");
assert(svc.getLocation(kash.token).error === "forbidden", "Unlinked parent loses location access");
assert(!JSON.stringify(feed).includes("fam_"), "Location API does not leak family row ids");

{
  const httpSvc = createFamilyService({ now: () => Date.parse("2026-09-15T14:00:00") });
  const app = express();
  app.use(express.json());
  mountFamilyRoutes(app, { limiter: (_req, _res, next) => next(), service: httpSvc });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const anon = await fetch(`${base}/api/family/location`);
    assert(anon.status === 401, "Location feed requires a session");
    const kashHttp = await fetch(`${base}/api/family/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "user_kash" }),
    }).then((r) => r.json());
    const anikaHttp = await fetch(`${base}/api/family/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "user_anika" }),
    }).then((r) => r.json());
    const auth = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
    const inviteHttp = await fetch(`${base}/api/family/invite`, { method: "POST", headers: auth(kashHttp.token) }).then(
      (r) => r.json()
    );
    await fetch(`${base}/api/family/pair`, {
      method: "POST",
      headers: auth(anikaHttp.token),
      body: JSON.stringify({ code: inviteHttp.code }),
    });
    const spoof = await fetch(`${base}/api/family/location`, {
      method: "POST",
      headers: auth(kashHttp.token),
      body: JSON.stringify({ lat: 1, lng: 1 }),
    });
    assert(spoof.status === 403, "HTTP parent cannot write member GPS");
    await fetch(`${base}/api/family/location`, {
      method: "POST",
      headers: auth(anikaHttp.token),
      body: JSON.stringify({ lat: 42.35, lng: -71.1 }),
    });
    httpSvc.addProfile({ id: "user_dad2", name: "Dad Two", role: ROLES.PARENT });
    const dad2 = await fetch(`${base}/api/family/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "user_dad2" }),
    }).then((r) => r.json());
    const leak = await fetch(`${base}/api/family/location`, { headers: auth(dad2.token) });
    assert(leak.status === 403, "HTTP other parent cannot read Anika’s location");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (failed) {
  console.error(`\n${failed} family check(s) failed`);
  process.exit(1);
}
console.log("\nAll family checks passed");
