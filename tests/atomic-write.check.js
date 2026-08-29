/**
 * Regression: a single fixed `.tmp` path meant concurrent writers clobbered each
 * other and every rename but one failed with ENOENT. 20 parallel writes must all
 * resolve, the newest value must survive, and no temp files may be left behind.
 */
import { mkdtemp, readdir, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupStaleTemps, pendingWriteCount, withFileLock, writeJsonAtomic } from "../server/atomic-write.js";
import { loadState, saveState, stateFilePath } from "../server/store.js";
import { listSubscriptions, saveSubscription, setSubscriptionsForTest } from "../server/push.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

const dir = await mkdtemp(path.join(tmpdir(), "routine-atomic-"));
const target = path.join(dir, "concurrent.json");

// --- 20 concurrent writes to one path ------------------------------------
const writes = Array.from({ length: 20 }, (_, i) => writeJsonAtomic(target, { n: i }));
const settled = await Promise.allSettled(writes);
const fulfilled = settled.filter((r) => r.status === "fulfilled").length;
const rejected = settled.filter((r) => r.status === "rejected");
assert(fulfilled === 20, `All 20 concurrent writes resolve (got ${fulfilled})`);
assert(rejected.length === 0, `No writer is rejected (got ${rejected.length}: ${rejected[0]?.reason?.code || ""})`);

const finalValue = JSON.parse(await readFile(target, "utf8"));
assert(finalValue.n === 19, `The last enqueued write wins (got n=${finalValue.n})`);

const leftovers = (await readdir(dir)).filter((n) => n.endsWith(".tmp"));
assert(leftovers.length === 0, `No temp files remain (got ${leftovers.length})`);
assert(pendingWriteCount() === 0, "Write queue drains to empty");

// --- interleaved writes to different paths --------------------------------
const a = path.join(dir, "a.json");
const b = path.join(dir, "b.json");
const mixed = await Promise.allSettled([
  writeJsonAtomic(a, { who: "a1" }),
  writeJsonAtomic(b, { who: "b1" }),
  writeJsonAtomic(a, { who: "a2" }),
  writeJsonAtomic(b, { who: "b2" }),
]);
assert(mixed.every((r) => r.status === "fulfilled"), "Concurrent writes to different paths all resolve");
assert(JSON.parse(await readFile(a, "utf8")).who === "a2", "Path a keeps its latest value");
assert(JSON.parse(await readFile(b, "utf8")).who === "b2", "Path b keeps its latest value");

// --- a failing write does not stall the queue ----------------------------
const chain = await Promise.allSettled([
  writeJsonAtomic(target, { n: 100 }),
  writeJsonAtomic(target, { n: 101 }),
]);
assert(chain.every((r) => r.status === "fulfilled"), "Queue keeps running after earlier work");
assert(JSON.parse(await readFile(target, "utf8")).n === 101, "Latest value survives a busy queue");

// --- lock serializes read-modify-write ------------------------------------
let counter = 0;
const locked = await Promise.all(
  Array.from({ length: 10 }, () =>
    withFileLock(target, async () => {
      const seen = counter;
      await new Promise((r) => setTimeout(r, 1));
      counter = seen + 1;
      return counter;
    })
  )
);
assert(counter === 10, `Locked read-modify-write does not lose updates (got ${counter})`);
assert(locked[locked.length - 1] === 10, "Lock returns each task's result in order");

// --- stale temp cleanup ---------------------------------------------------
const staleTmp = `${target}.9999.abandoned.tmp`;
await writeFile(staleTmp, "{}", "utf8");
const old = new Date(Date.now() - 60 * 60 * 1000);
await utimes(staleTmp, old, old);
const freshTmp = `${target}.9999.fresh.tmp`;
await writeFile(freshTmp, "{}", "utf8");
const removed = await cleanupStaleTemps(target, 5 * 60 * 1000);
assert(removed === 1, `Only the abandoned temp is removed (got ${removed})`);
const after = (await readdir(dir)).filter((n) => n.endsWith(".tmp"));
assert(after.length === 1 && after[0].includes("fresh"), "A recent temp is left alone");
await rm(freshTmp, { force: true });

// --- concurrency through the real state store ----------------------------
const dbPath = stateFilePath();
const dbDir = path.dirname(dbPath);
const stateWrites = await Promise.allSettled(
  Array.from({ length: 20 }, (_, i) => saveState({ settings: {}, events: [], notes: [], marker: i }))
);
const stateOk = stateWrites.filter((r) => r.status === "fulfilled").length;
assert(stateOk === 20, `20 concurrent saveState calls all resolve (got ${stateOk})`);
const reloaded = await loadState();
assert(reloaded.marker === 19, `saveState keeps the newest state (got marker=${reloaded.marker})`);
const dbTemps = (await readdir(dbDir)).filter((n) => n.startsWith("db.json.") && n.endsWith(".tmp"));
assert(dbTemps.length === 0, `No db temp files remain (got ${dbTemps.length})`);

// --- concurrency through the subscription store --------------------------
setSubscriptionsForTest([]);
const sub = (n) => ({
  endpoint: `https://push.example/concurrent-${n}`,
  keys: { p256dh: `p256dh-key-value-${n}`, auth: `auth-key-${n}` },
});
const subWrites = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => saveSubscription(sub(i))));
const subOk = subWrites.filter((r) => r.status === "fulfilled" && r.value?.ok).length;
assert(subOk === 20, `20 concurrent subscription saves all resolve (got ${subOk})`);
assert(listSubscriptions().length === 20, `All 20 devices are retained (got ${listSubscriptions().length})`);
const subTemps = (await readdir(dbDir)).filter(
  (n) => n.startsWith("push-subscriptions.json.") && n.endsWith(".tmp")
);
assert(subTemps.length === 0, `No subscription temp files remain (got ${subTemps.length})`);
setSubscriptionsForTest([]);
await rm(path.join(dbDir, "push-subscriptions.json"), { force: true });
await rm(dbPath, { force: true });

await rm(dir, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} atomic-write check(s) failed`);
  process.exit(1);
}
console.log("\nAll atomic-write checks passed");
