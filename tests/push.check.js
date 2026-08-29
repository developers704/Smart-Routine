/**
 * Web Push server logic: due-time delivery (the bug that meant nothing ever
 * fired), multi-device subscriptions, legacy migration and pruning.
 * No network — the sender is injected.
 */
import {
  loadSubscriptions,
  mergeSubscriptions,
  parseSubscriptionFile,
  resetSentForTest,
  sendToAll,
  setStateLoaderForTest,
  setSubscriptionsForTest,
  setVapidReadyForTest,
  subscriptionCount,
  tickPush,
} from "../server/push.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

const sub = (n) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: `k${n}`, auth: `a${n}` } });

// --- file parsing / migration --------------------------------------------
assert(parseSubscriptionFile("{}").length === 0, "An empty object file yields no subscriptions");
assert(parseSubscriptionFile("not json").length === 0, "Corrupt JSON yields no subscriptions");
assert(parseSubscriptionFile("[]").length === 0, "An empty array yields no subscriptions");
const legacy = parseSubscriptionFile(JSON.stringify(sub(1)));
assert(legacy.length === 1 && legacy[0].endpoint === sub(1).endpoint, "A legacy single subscription is preserved");
assert(
  parseSubscriptionFile(JSON.stringify([sub(1), sub(2)])).length === 2,
  "The new array format loads every subscription"
);
assert(
  parseSubscriptionFile(JSON.stringify([sub(1), { keys: {} }, null])).length === 1,
  "Entries without an endpoint are dropped"
);

const merged = mergeSubscriptions([sub(1)], [sub(2)]);
assert(merged.length === 2, "Merging keeps both devices");
assert(
  mergeSubscriptions([sub(1)], [{ ...sub(1), keys: { p256dh: "new", auth: "new" } }]).length === 1,
  "Re-subscribing the same endpoint does not duplicate it"
);
assert(
  mergeSubscriptions([sub(1)], [{ ...sub(1), keys: { p256dh: "new", auth: "new" } }])[0].keys.p256dh === "new",
  "Re-subscribing refreshes the stored keys"
);

// --- fan-out and pruning --------------------------------------------------
const seen = [];
const okSender = async (s) => {
  seen.push(s.endpoint);
};
const fan = await sendToAll([sub(1), sub(2), sub(3)], { title: "t" }, okSender);
assert(fan.delivered.length === 3, `Every device receives the payload (got ${fan.delivered.length})`);
assert(seen.length === 3, "Sender was invoked once per device");

const goneSender = async (s) => {
  if (s.endpoint.endsWith("2")) {
    const err = new Error("gone");
    err.statusCode = 410;
    throw err;
  }
};
const pruned = await sendToAll([sub(1), sub(2), sub(3)], { title: "t" }, goneSender);
assert(pruned.gone.length === 1 && pruned.gone[0] === sub(2).endpoint, "410 endpoints are reported for pruning");
assert(pruned.delivered.length === 2, "Live devices still receive the payload");

const errSender = async () => {
  const err = new Error("boom");
  err.statusCode = 500;
  throw err;
};
const errored = await sendToAll([sub(1)], { title: "t" }, errSender);
assert(errored.failed.length === 1 && errored.gone.length === 0, "A 500 is a failure, not a pruning signal");

// --- due-time delivery ----------------------------------------------------
const now = Date.parse("2026-08-24T12:00:00");
const state = {
  settings: { alarmLeadMin: 10 },
  events: [
    { id: "e1", title: "Gym", kind: "gym", category: "gym", start: new Date(now).toISOString(), end: new Date(now + 3600000).toISOString() },
  ],
  notes: [],
};
setStateLoaderForTest(async () => state);
process.env.VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "test-public-key";

setSubscriptionsForTest([sub(1), sub(2)]);
resetSentForTest();
setVapidReadyForTest(true);
const sentTo = [];
const recordSender = async (s, payload) => {
  sentTo.push({ endpoint: s.endpoint, payload: JSON.parse(payload) });
};

const tick = await tickPush(now, recordSender);
assert(tick.due === 1, `An event starting now is due (got ${tick.due})`);
assert(tick.sent === 1, `The due item is delivered (got ${tick.sent})`);
assert(sentTo.length === 2, `Both devices got the due notification (got ${sentTo.length})`);
assert(sentTo[0].payload.title === "Gym", "Payload carries the event title");
assert(Boolean(sentTo[0].payload.tag), "Payload carries a stable tag for dedupe");

sentTo.length = 0;
const again = await tickPush(now + 5_000, recordSender);
assert(again.sent === 0 && sentTo.length === 0, "The same item is never sent twice");

resetSentForTest();
sentTo.length = 0;
const early = await tickPush(now - 120_000, recordSender);
assert(early.sent === 0 && sentTo.length === 0, "Nothing is sent before the fire time");

resetSentForTest();
sentTo.length = 0;
const late = await tickPush(now + 120_000, recordSender);
assert(late.sent === 0 && sentTo.length === 0, "Nothing is sent long after the fire time");

resetSentForTest();
sentTo.length = 0;
const leadNow = now + 50 * 60 * 1000;
const leadState = {
  settings: { alarmLeadMin: 10 },
  events: [
    { id: "e2", title: "MCAT studying", kind: "mcat", category: "study", start: new Date(leadNow + 10 * 60 * 1000).toISOString(), end: new Date(leadNow + 70 * 60 * 1000).toISOString() },
  ],
  notes: [],
};
setStateLoaderForTest(async () => leadState);
const lead = await tickPush(leadNow, recordSender);
assert(lead.sent === 1, "The 10-minute lead notification is delivered on time");
assert(sentTo[0].payload.body.includes("In 10 min"), "Lead payload says how long until the event");

resetSentForTest();
setSubscriptionsForTest([]);
setStateLoaderForTest(async () => state);
const noSubs = await tickPush(now, recordSender);
assert(noSubs.sent === 0, "With no subscriptions nothing is attempted");
assert(subscriptionCount() === 0, "Subscription count reflects an empty store");

// --- misconfigured keys must not send ------------------------------------
setSubscriptionsForTest([sub(1)]);
setVapidReadyForTest(false);
resetSentForTest();
sentTo.length = 0;
const unconfigured = await tickPush(now, recordSender);
assert(unconfigured.sent === 0 && sentTo.length === 0, "Nothing is sent while VAPID is unconfigured");
setVapidReadyForTest(true);
setSubscriptionsForTest([]);

// --- legacy file migration on disk ---------------------------------------
const legacyPath = path.join(dataDir, "push-subscription.json");
const newPath = path.join(dataDir, "push-subscriptions.json");
await mkdir(dataDir, { recursive: true });
await rm(newPath, { force: true });
await writeFile(legacyPath, JSON.stringify(sub(9)), "utf8");
const migrated = await loadSubscriptions();
assert(migrated.length === 1 && migrated[0].endpoint === sub(9).endpoint, "Legacy file migrates into the new store");
assert(subscriptionCount() === 1, "Migrated subscription is loaded into memory");
const onDisk = parseSubscriptionFile(await readFile(newPath, "utf8"));
assert(onDisk.length === 1, "Migration writes the new multi-subscription file");
assert(
  await readFile(legacyPath, "utf8").then(
    () => false,
    () => true
  ),
  "Legacy file is removed after a successful migration"
);

await writeFile(legacyPath, "{}", "utf8");
await rm(newPath, { force: true });
const emptyLegacy = await loadSubscriptions();
assert(emptyLegacy.length === 0, "An empty legacy object migrates to nothing");
await rm(legacyPath, { force: true });
await rm(newPath, { force: true });

if (failed) {
  console.error(`\n${failed} push check(s) failed`);
  process.exit(1);
}
console.log("\nAll push checks passed");
