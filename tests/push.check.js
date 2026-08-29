/**
 * Web Push server logic: due-time delivery (the bug that meant nothing ever
 * fired), multi-device subscriptions, legacy migration and pruning.
 * No network — the sender is injected.
 */
import {
  cancelTestPush,
  deliveryStateForTest,
  hasSubscription,
  isValidSubscription,
  loadDeliveryForTest,
  loadSubscriptions,
  mergeSubscriptions,
  parseSubscriptionFile,
  pendingTestPushes,
  resetSentForTest,
  scheduleTestPush,
  sendToAll,
  setPersistenceForTest,
  setStateLoaderForTest,
  setSubscriptionsForTest,
  setVapidReadyForTest,
  subscriptionCount,
  tickPush,
} from "../server/push.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

setPersistenceForTest(false);

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

const sub = (n) => ({
  endpoint: `https://push.example/${n}`,
  keys: {
    p256dh: `BEl62iUYgUivxIkv69yViEuiBIa40HI${String(n).padStart(2, "0")}wpsQmJqEkFhTZBOZ3lVc`,
    auth: `tBHItJI5svbpez7KI4CC${String(n).padStart(2, "0")}`,
  },
});

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
const refreshedKeys = { p256dh: "BEl62iUYgUivxIkv69yViEuiBIa40HI99wpsQmJqEkFhTZBOZ3lVcREFRESH", auth: "tBHItJI5svbpez7KI4CC99" };
assert(
  mergeSubscriptions([sub(1)], [{ ...sub(1), keys: refreshedKeys }]).length === 1,
  "Re-subscribing the same endpoint does not duplicate it"
);
assert(
  mergeSubscriptions([sub(1)], [{ ...sub(1), keys: refreshedKeys }])[0].keys.p256dh === refreshedKeys.p256dh,
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
assert(tick.sent === 2, `The due item is delivered to both devices (got ${tick.sent})`);
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
assert(lead.sent === 2, `The 10-minute lead notification reaches both devices (got ${lead.sent})`);
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

// --- per-device retry -----------------------------------------------------
// Regression: an item was marked sent globally before fan-out, so a device that
// hit a transient 500 while another succeeded was never retried.
setStateLoaderForTest(async () => state);
setSubscriptionsForTest([sub(1), sub(2)]);
resetSentForTest();
const attempts = [];
let failDevice2 = true;
const flakySender = async (s, payload) => {
  attempts.push(s.endpoint);
  if (s.endpoint === sub(2).endpoint && failDevice2) {
    const err = new Error("transient");
    err.statusCode = 500;
    throw err;
  }
  return JSON.parse(payload);
};

const t1 = await tickPush(now, flakySender);
assert(t1.sent === 1, `Device A is delivered on the first tick (got ${t1.sent})`);
assert(t1.failed === 1, `Device B is recorded as failed (got ${t1.failed})`);
assert(t1.pendingRetries === 1, `Device B is queued for retry (got ${t1.pendingRetries})`);

const state1 = deliveryStateForTest();
assert(state1.delivered.size === 1, "Only the successful device has a delivery receipt");
assert(
  [...state1.delivered.keys()][0].includes(sub(1).endpoint),
  "The receipt is keyed by item and endpoint"
);

attempts.length = 0;
const tooSoon = await tickPush(now + 5_000, flakySender);
assert(tooSoon.retried === 0 && attempts.length === 0, "Retry waits for its backoff");

attempts.length = 0;
failDevice2 = false;
const t2 = await tickPush(now + 20_000, flakySender);
assert(t2.retried === 1, `The failed device is retried after backoff (got ${t2.retried})`);
assert(t2.sent === 1, "The retry succeeds");
assert(attempts.length === 1 && attempts[0] === sub(2).endpoint, "Only the failed device is retried");
assert(deliveryStateForTest().delivered.size === 2, "Both devices now have receipts");
assert(deliveryStateForTest().retries.size === 0, "The retry queue drains");

attempts.length = 0;
const t3 = await tickPush(now + 25_000, flakySender);
assert(t3.sent === 0 && attempts.length === 0, "A delivered item is never re-sent to either device");

// bounded: give up after MAX_ATTEMPTS rather than retrying forever
setSubscriptionsForTest([sub(3)]);
resetSentForTest();
let calls = 0;
const alwaysFails = async () => {
  calls++;
  const err = new Error("still broken");
  err.statusCode = 500;
  throw err;
};
await tickPush(now, alwaysFails);
await tickPush(now + 20_000, alwaysFails);
await tickPush(now + 100_000, alwaysFails);
await tickPush(now + 400_000, alwaysFails);
await tickPush(now + 900_000, alwaysFails);
assert(calls === 3, `Retries stop after 3 attempts (got ${calls})`);
assert(deliveryStateForTest().retries.size === 0, "The exhausted retry is dropped from the queue");

// a 410 during retry prunes that device only
setSubscriptionsForTest([sub(1), sub(2)]);
resetSentForTest();
let phase = 0;
const goneOnRetry = async (s) => {
  if (s.endpoint === sub(2).endpoint) {
    const err = new Error(phase === 0 ? "transient" : "gone");
    err.statusCode = phase === 0 ? 500 : 410;
    throw err;
  }
};
await tickPush(now, goneOnRetry);
phase = 1;
await tickPush(now + 20_000, goneOnRetry);
assert(subscriptionCount() === 1, `A 410 on retry prunes just that device (got ${subscriptionCount()})`);
assert(hasSubscription(sub(1).endpoint), "The healthy device is retained");

// --- receipts survive a restart ------------------------------------------
setSubscriptionsForTest([sub(1)]);
resetSentForTest();
const restartSender = async () => {};
await tickPush(now, restartSender);
const receipts = [...deliveryStateForTest().delivered.entries()];
assert(receipts.length === 1, "One receipt recorded before the restart");

resetSentForTest();
loadDeliveryForTest(receipts);
attempts.length = 0;
const afterRestart = await tickPush(now + 10_000, async (s) => {
  attempts.push(s.endpoint);
});
assert(
  afterRestart.sent === 0 && attempts.length === 0,
  "Restored receipts stop a resend after a PM2 restart"
);

resetSentForTest();
const staleReceipts = receipts.map(([key]) => [key, now - 72 * 60 * 60 * 1000]);
loadDeliveryForTest(staleReceipts);
const afterExpiry = await tickPush(now, async () => {});
assert(afterExpiry.sent === 1, "Receipts older than the retention window are ignored");

// --- device-scoped test push ---------------------------------------------
setSubscriptionsForTest([sub(1), sub(2)]);
assert(
  scheduleTestPush({ minutes: 2 }).error === "endpoint-required",
  "A test push without an endpoint is rejected"
);
assert(
  scheduleTestPush({ minutes: 2, endpoint: "https://push.example/nope" }).error === "unknown-endpoint",
  "A test push for an unknown device is rejected"
);
const scheduled = scheduleTestPush({ minutes: 2, endpoint: sub(1).endpoint });
assert(scheduled.ok && scheduled.minutes === 2, "A test push is scheduled for the calling device");
assert(pendingTestPushes() === 1, `Only one device has a pending test (got ${pendingTestPushes()})`);
const second = scheduleTestPush({ minutes: 2, endpoint: sub(2).endpoint });
assert(second.ok && pendingTestPushes() === 2, "Each device gets its own timer");
assert(cancelTestPush(sub(1).endpoint) === true, "A device's test push can be cancelled");
assert(pendingTestPushes() === 1, "Cancelling one device leaves the other's test alone");
assert(cancelTestPush(sub(2).endpoint) === true, "The remaining test can be cancelled");
assert(scheduleTestPush({ minutes: 999, endpoint: sub(1).endpoint }).minutes === 60, "Test delay is clamped");
cancelTestPush(sub(1).endpoint);

// --- subscription validation ---------------------------------------------
assert(isValidSubscription(sub(1)) === true, "A complete subscription is accepted");
assert(isValidSubscription({ endpoint: "https://push.example/x" }) === false, "Missing keys are rejected");
assert(
  isValidSubscription({ endpoint: "http://push.example/x", keys: sub(1).keys }) === false,
  "A non-HTTPS endpoint is rejected"
);
assert(
  isValidSubscription({ endpoint: "https://push.example/x", keys: { p256dh: "short", auth: "tiny" } }) === false,
  "Implausibly short keys are rejected"
);
assert(isValidSubscription(null) === false, "Null is rejected");
assert(
  isValidSubscription({ endpoint: `https://push.example/${"x".repeat(1100)}`, keys: sub(1).keys }) === false,
  "An oversized endpoint is rejected"
);
assert(parseSubscriptionFile(JSON.stringify([sub(1), { endpoint: "https://x/y" }])).length === 1, "Invalid entries are filtered on load");

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
