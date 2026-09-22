import { randomBytes } from "node:crypto";
import {
  DEFAULT_MONITOR,
  ROLES,
  SEED_ACCOUNTS,
  STALE_AFTER_MS,
  UNAVAILABLE_AFTER_MS,
  canReadFamilyLocation,
  canWriteFamilyLocation,
  freshnessLabel,
  geofenceTransition,
  haversineMeters,
  homeAlertBody,
  formatMonitorWindow,
  isAllDayMonitor,
  minutesFromMidnight,
  minutesToTimeInput,
  timeInputToMinutes,
  homeAwayStatus,
  inMonitorWindow,
  isAtHome,
  locationFreshness,
  pruneLocationHistory,
  shouldSendHomeAlert,
  visitsAtPlaces,
} from "../client/shared/family.js";
import {
  createFamilyService,
  familyPasswordHashFromEnv,
  mountFamilyRoutes,
  SESSION_TTL_MS,
  TEST_FAMILY_PASSWORD_HASHES,
} from "../server/family.js";
import { hashPassword, parsePasswordHash, verifyPassword } from "../server/password.js";
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

assert(SEED_ACCOUNTS.some((p) => p.name === "Kash Valliani" && p.role === ROLES.PARENT), "Kash is the parent account");
assert(SEED_ACCOUNTS.some((p) => p.name === "Anika" && p.role === ROLES.MEMBER), "Anika is the member account");
assert(!SEED_ACCOUNTS.some((p) => p.passwordHash), "Seed metadata has no password hashes");

const now = Date.parse("2026-09-15T08:00:00Z");
assert(locationFreshness(new Date(now - 60_000).toISOString(), now) === "accurate", "Fresh fix is accurate");
assert(locationFreshness(new Date(now - STALE_AFTER_MS - 1000).toISOString(), now) === "stale", "Old fix is stale");
assert(
  locationFreshness(new Date(now - UNAVAILABLE_AFTER_MS - 1000).toISOString(), now) === "offline",
  "Very old fix is offline"
);
assert(locationFreshness(null, now) === "unavailable", "Never seen is unavailable");
assert(locationFreshness(new Date(now - 1000).toISOString(), now, { paused: true }) === "paused", "Paused sharing");
assert(locationFreshness(new Date(now - 1000).toISOString(), now, { permission: "denied" }) === "denied", "Denied permission");
assert(locationFreshness(new Date(now - 1000).toISOString(), now, { permission: "disabled" }) === "disabled", "Location off");
assert(locationFreshness(new Date(now - 1000).toISOString(), now, { permission: "offline" }) === "offline", "Offline permission");
assert(freshnessLabel("accurate") === "Updated", "Accurate is labeled Updated, not Live");
assert(!/live/i.test(freshnessLabel("accurate")), "Never says Live");
assert(freshnessLabel("stale") === "Stale", "Stale label");
assert(freshnessLabel("offline") === "Offline", "Offline label");

const home = { lat: 42.3468, lng: -71.1039 };
assert(isAtHome({ lat: 42.3468, lng: -71.1039 }, home, 150), "At home");
assert(!isAtHome({ lat: 42.36, lng: -71.06 }, home, 150), "Downtown is away");
assert(haversineMeters(home, home) < 1, "Zero distance at same point");

assert(inMonitorWindow(new Date(2026, 8, 15, 0, 30), DEFAULT_MONITOR), "12:30 AM is in the default window");
assert(inMonitorWindow(new Date(2026, 8, 15, 4, 59), DEFAULT_MONITOR), "4:59 AM is in the default window");
assert(!inMonitorWindow(new Date(2026, 8, 15, 5, 0), DEFAULT_MONITOR), "5:00 AM is outside the default window");
assert(!inMonitorWindow(new Date(2026, 8, 15, 12, 0), DEFAULT_MONITOR), "Noon is outside the window");
assert(minutesToTimeInput(0) === "00:00", "Midnight formats as a time input");
assert(minutesToTimeInput(300) === "05:00", "5:00 AM formats as a time input");
assert(timeInputToMinutes("05:00") === 300, "Time input converts back to minutes");
assert(timeInputToMinutes("23:59") === 23 * 60 + 59, "11:59 PM converts");
assert(minutesFromMidnight(1440) === 0, "24:00 wraps to midnight");
assert(isAllDayMonitor({ startMin: 0, endMin: 0 }), "Equal start and end is all day");
assert(inMonitorWindow(new Date(2026, 8, 15, 15, 30), { startMin: 0, endMin: 0 }), "All-day window alerts at 3:30 PM");
assert(formatMonitorWindow({ startMin: 0, endMin: 300 }) === "12:00 AM–5:00 AM", "Default window is labeled in clock time");
assert(formatMonitorWindow({ startMin: 0, endMin: 0 }) === "All day", "All-day window is labeled All day");

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
assert(homeAwayStatus({ lat: 42.36, lng: -71.06 }, home, 150, "offline") === "unknown", "Offline hides home/away");

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
assert(canReadFamilyLocation({ id: "user_kash", role: ROLES.PARENT }, famA), "Kash can read Anika’s family");
assert(!canReadFamilyLocation({ id: "user_other", role: ROLES.PARENT }, famA), "Another parent cannot read Kash’s family");
assert(!canWriteFamilyLocation({ id: "user_kash", role: ROLES.PARENT }, famA), "Parent cannot post member location");
assert(canWriteFamilyLocation({ id: "user_anika", role: ROLES.MEMBER }, famA), "Anika can post her location");
assert(!canReadFamilyLocation({ id: "user_kash", role: ROLES.PARENT }, famB), "Kash cannot read another family’s data");

const secretA = randomBytes(16).toString("hex");
const secretB = randomBytes(16).toString("hex");
const hashedA = await hashPassword(secretA);
const hashedB = await hashPassword(secretA);
assert(hashedA.ok && hashedB.ok, "Passwords hash with scrypt");
assert(hashedA.hash !== hashedB.hash, "Each hash uses a unique salt");
assert(parsePasswordHash(hashedA.hash)?.salt.length > 0, "Salt is stored with the hash");
assert(await verifyPassword(secretA, hashedA.hash), "Correct password verifies");
assert(!(await verifyPassword(secretB, hashedA.hash)), "Wrong password is rejected");
assert((await hashPassword("123456")).ok, "Six-character test password hashes");
assert(!(await hashPassword("short")).ok, "Short passwords are rejected");
assert(
  familyPasswordHashFromEnv("user_kash", {}) === TEST_FAMILY_PASSWORD_HASHES.user_kash,
  "Empty env uses the kash test hash"
);
assert(
  familyPasswordHashFromEnv("user_anika", {}) === TEST_FAMILY_PASSWORD_HASHES.user_anika,
  "Empty env uses the anika test hash"
);
assert(
  familyPasswordHashFromEnv("user_kash", { FAMILY_KASH_PASSWORD_HASH: "scrypt$custom" }) === "scrypt$custom",
  "FAMILY_KASH_PASSWORD_HASH overrides the test hash"
);

{
  const testLogin = createFamilyService({ now: () => Date.parse("2026-09-15T01:00:00") });
  testLogin.applyPasswordHash("user_kash", TEST_FAMILY_PASSWORD_HASHES.user_kash);
  testLogin.applyPasswordHash("user_anika", TEST_FAMILY_PASSWORD_HASHES.user_anika);
  const kashTest = await testLogin.signIn({ username: "kash", password: "123456" });
  const anikaTest = await testLogin.signIn({ username: "anika", password: "123456" });
  assert(kashTest.ok && kashTest.user.role === "parent", "Kash signs in with the temporary test password");
  assert(anikaTest.ok && anikaTest.user.role === "member", "Anika signs in with the temporary test password");
  assert(!(await testLogin.signIn({ username: "kash", password: "654321" })).ok, "Wrong test password is rejected");
}

let clock = Date.parse("2026-09-15T01:00:00");
const pushes = [];
const svc = createFamilyService({
  now: () => clock,
  sendPush: async (msg) => {
    pushes.push(msg);
  },
  sessionTtlMs: SESSION_TTL_MS,
});
assert((await svc.setPasswordHash("user_kash", secretA)).ok, "Kash password hash is set in tests only");
assert((await svc.setPasswordHash("user_anika", secretB)).ok, "Anika password hash is set in tests only");

const bad = await svc.signIn({ username: "kash", password: secretB });
assert(bad.error === "unauthorized", "Incorrect password is rejected");
const kash = await svc.signIn({ username: "kash", password: secretA });
const anika = await svc.signIn({ username: "anika", password: secretB });
assert(kash.ok && kash.token && kash.user.role === "parent", "Kash role comes from the server after login");
assert(anika.ok && anika.user.role === "member", "Anika role comes from the server after login");
assert(!kash.user.passwordHash, "Login response has no password hash");
assert(svc.me("").error === "unauthorized", "Missing session is unauthorized");

const expired = createFamilyService({ now: () => clock, sessionTtlMs: 1 });
await expired.setPasswordHash("user_kash", secretA);
const short = await expired.signIn({ username: "kash", password: secretA });
clock += 50;
assert(expired.me(short.token).error === "unauthorized", "Expired sessions cannot read location");
clock = Date.parse("2026-09-15T01:00:00");

assert(svc.getLocation("").error === "unauthorized", "Unauthenticated location is unauthorized");
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

clock = Date.parse("2026-09-15T02:10:00");
const near = await svc.ingestLocation(anika.token, { lat: 42.34752, lng: -71.1039, at: new Date(clock).toISOString() });
assert(near.ok && near.alert == null, "80m from Home stays inside a 150m radius");
const shrink = await svc.setHome(kash.token, { lat: 42.3468, lng: -71.1039, radiusM: 40, startMin: 0, endMin: 5 * 60 });
assert(shrink.ok && shrink.alert === "away", "Saving a smaller radius alerts Away without a new GPS ping");
assert(pushes.length === 3 && pushes[2].userId === "user_kash", "Radius change pushes Kash");
const expand = await svc.setHome(kash.token, { lat: 42.3468, lng: -71.1039, radiusM: 150, startMin: 0, endMin: 5 * 60 });
assert(expand.ok && expand.alert === "returned", "Saving the larger radius alerts Returned");

clock = Date.parse("2026-09-15T12:00:00");
const noon = await svc.ingestLocation(anika.token, { lat: 42.36, lng: -71.06, at: new Date(clock).toISOString() });
assert(noon.alert == null, "Away at noon does not use the overnight geofence");

clock = Date.parse("2026-09-15T12:20:00");
const backHome = await svc.ingestLocation(anika.token, {
  lat: 42.3468,
  lng: -71.1039,
  at: new Date(clock).toISOString(),
});
assert(backHome.ok && backHome.alert == null, "12:20 PM return is outside the overnight window");
await svc.setHome(kash.token, { lat: 42.3468, lng: -71.1039, radiusM: 150, startMin: 0, endMin: 0 });
clock = Date.parse("2026-09-15T12:40:00");
const afternoonAway = await svc.ingestLocation(anika.token, { lat: 42.36, lng: -71.06, at: new Date(clock).toISOString() });
assert(afternoonAway.ok && afternoonAway.alert === "away", "All-day window alerts when Anika leaves at 12:40 PM");
await svc.setHome(kash.token, { lat: 42.3468, lng: -71.1039, radiusM: 150, startMin: 0, endMin: 5 * 60 });

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
assert(!JSON.stringify(feed).includes("fam_"), "Location API does not leak family row ids");

const otherSecret = randomBytes(16).toString("hex");
svc.addAccount({ id: "user_other", username: "otherdad", name: "Other Dad", role: ROLES.PARENT });
await svc.setPasswordHash("user_other", otherSecret);
const otherDad = await svc.signIn({ username: "otherdad", password: otherSecret });
assert(svc.getLocation(otherDad.token).error === "forbidden", "Another parent cannot read Anika’s location");

assert(svc.deleteLocationHistory(kash.token).ok, "Parent can delete location history");
assert(svc.getLocation(kash.token).today.length === 0, "History deletion clears points");

const apnsTok = "a".repeat(64);
assert(svc.registerApns(kash.token, apnsTok).ok, "Kash can register an APNs token");
assert(svc.listApnsForUser("user_kash").includes(apnsTok), "Token is stored on Kash’s account");
assert(svc.registerApns(anika.token, apnsTok).ok, "Replacement moves the token to the new account");
assert(!svc.listApnsForUser("user_kash").includes(apnsTok), "Old account loses the replaced token");
assert(svc.removeApnsToken(apnsTok), "Invalid tokens can be dropped");

{
  const httpSvc = createFamilyService({ now: () => Date.parse("2026-09-15T14:00:00") });
  const passK = randomBytes(16).toString("hex");
  const passA = randomBytes(16).toString("hex");
  await httpSvc.setPasswordHash("user_kash", passK);
  await httpSvc.setPasswordHash("user_anika", passA);
  httpSvc.addAccount({ id: "user_dad2", username: "dad2", name: "Dad Two", role: ROLES.PARENT });
  const passD = randomBytes(16).toString("hex");
  await httpSvc.setPasswordHash("user_dad2", passD);
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
    const roleGuess = await fetch(`${base}/api/family/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "kash", password: passK, role: "parent" }),
    });
    assert(roleGuess.status === 400, "Client cannot submit a role");
    const kashHttp = await fetch(`${base}/api/family/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "kash", password: passK }),
    }).then((r) => r.json());
    const anikaHttp = await fetch(`${base}/api/family/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "anika", password: passA }),
    }).then((r) => r.json());
    const auth = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
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
    const dad2 = await fetch(`${base}/api/family/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dad2", password: passD }),
    }).then((r) => r.json());
    const leak = await fetch(`${base}/api/family/location`, { headers: auth(dad2.token) });
    assert(leak.status === 403, "HTTP other parent cannot read Anika’s location");
    const hist = await fetch(`${base}/api/family/location`, { headers: auth(dad2.token) });
    assert(hist.status === 403, "HTTP other parent cannot read Anika’s history");
    const inviteGone = await fetch(`${base}/api/family/invite`, { method: "POST", headers: auth(kashHttp.token) });
    assert(inviteGone.status === 404, "Invite/pairing routes are removed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (failed) {
  console.error(`\n${failed} family check(s) failed`);
  process.exit(1);
}
console.log("\nAll family checks passed");
