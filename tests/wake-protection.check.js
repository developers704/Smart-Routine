import {
  ALARM_PLAN_CAP,
  ALARM_TEST_SLOTS,
  backupAlarmId,
  buildAlarmKitItems,
  buildAlarmPlan,
  buildPlan,
  isBackupAlarmId,
  primaryIdOfBackup,
  wakeVerificationSettings,
} from "../client/shared/alarm-plan.js";
import { uuidFromPlanId, testAlarmUuid, ALARM_UUID_NAMESPACE } from "../client/shared/alarm-identity.js";
import {
  applyForceClose,
  applySystemStop,
  applyVerificationSuccess,
  applyWrongAnswer,
  createAlarmStore,
  protectionSet,
  snoozeAndMathOverlap,
  syncProtection,
} from "../client/shared/wake-protection.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

const now = Date.parse("2026-08-24T12:00:00");
const at = (h) => new Date(now + h * 3600000).toISOString();

const settings = {
  alarmLeadMin: 10,
  wakeVerificationEnabled: true,
  mathDifficulty: "medium",
  mathQuestionCount: 2,
  backupAlarmCount: 2,
  backupIntervalMin: 1,
  snoozeMin: 9,
};

const sleepSoon = { id: "s1", title: "Sleep", kind: "sleep", category: "sleep", start: at(-7), end: at(1) };
const sleepLater = { id: "s2", title: "Sleep", kind: "sleep", category: "sleep", start: at(20), end: at(28) };
const shift = { id: "w1", title: "Shift Morning", kind: "work", category: "work", start: at(5), end: at(13) };
const gym = { id: "g1", title: "Gym", kind: "gym", category: "gym", start: at(3), end: at(4) };

const wv = wakeVerificationSettings(settings);
assert(wv.enabled === true && wv.method === "math", "Wake verification normalises to math");
assert(wv.backupCount === 2 && wv.backupIntervalMin === 1, "Backup defaults honour settings");
assert(wakeVerificationSettings({}).enabled === false, "Verification is off by default");
assert(wakeVerificationSettings({ backupAlarmCount: 99 }).backupCount === 3, "Backup count is clamped to 3");
assert(wakeVerificationSettings({ snoozeMin: 0 }).snoozeMin === 1, "Snooze is at least 1 minute");
assert(wakeVerificationSettings({ snoozeMin: 90 }).snoozeMin === 60, "Snooze is at most 60 minutes");

assert(backupAlarmId("p", 1) === "p:backup:1", "Backup id is primary-id:backup:n");
assert(isBackupAlarmId("p:backup:2"), "Backup ids are detected");
assert(primaryIdOfBackup("p:backup:3") === "p", "Primary is recovered from a backup id");

const state = { settings, events: [sleepSoon, sleepLater, shift, gym], notes: [] };
const kit = buildAlarmKitItems(state, now);

assert(kit.nearestWake?.eventId === "s1", "Only the nearest upcoming wake is protected");
assert(kit.backups.length === 2, `Nearest wake gets ${wv.backupCount} backups (got ${kit.backups.length})`);
assert(
  kit.backups.every((b) => b.primaryId === kit.nearestWake.id),
  "Backups point at the protected primary"
);
assert(
  kit.backups[0].id === backupAlarmId(kit.nearestWake.id, 1) && kit.backups[1].id === backupAlarmId(kit.nearestWake.id, 2),
  "Backup identities are deterministic :backup:1 and :backup:2"
);
assert(
  kit.backups[0].at.getTime() === kit.nearestWake.at.getTime() + 60000,
  "First backup is backupIntervalMin after the primary"
);
assert(
  kit.items.filter((i) => i.role === "wake" && !i.isBackup && i.eventId === "s2" && i.protected).length === 0,
  "A later wake is not protected"
);
assert(kit.nearestWake.snooze === false && kit.nearestWake.protected === true, "Protected wake has no snooze");
assert(
  kit.items.filter((i) => i.role === "shift").every((i) => i.snooze === true && i.protected === false),
  "Shift alarms keep normal snooze"
);
assert(!snoozeAndMathOverlap(kit.items), "Snooze and math verification never overlap");

const again = buildAlarmKitItems(state, now);
assert(
  again.items.map((i) => i.id).join() === kit.items.map((i) => i.id).join(),
  "Regeneration does not duplicate primary or backup ids"
);
assert(uuidFromPlanId(kit.nearestWake.id) === uuidFromPlanId(kit.nearestWake.id), "UUID v5 is stable");
assert(uuidFromPlanId(kit.backups[0].id) !== uuidFromPlanId(kit.nearestWake.id), "Backup UUID differs from primary");
assert(testAlarmUuid() === uuidFromPlanId("routine-test-alarm"), "Test alarm uses the reserved identity");
assert(ALARM_UUID_NAMESPACE.startsWith("6dc9a1a0"), "Namespace UUID is fixed");

const rebuiltState = { ...state };
assert(
  buildAlarmKitItems(rebuiltState, now).nearestWake.id === kit.nearestWake.id,
  "Restarting from the same events keeps the wake identity"
);

const verified = {
  ...state,
  events: [{ ...sleepSoon, verifiedAt: new Date(now).toISOString() }, sleepLater, shift, gym],
};
const afterVerify = buildAlarmKitItems(verified, now);
assert(afterVerify.nearestWake?.eventId === "s2", "Successful verification moves protection to the next wake");
assert(
  !afterVerify.items.some((i) => i.eventId === "s1"),
  "Verified sleep no longer schedules a wake or backups"
);

const deleted = { ...state, events: [sleepLater, shift, gym] };
const afterDelete = buildAlarmKitItems(deleted, now);
assert(!afterDelete.items.some((i) => i.eventId === "s1"), "Deleting the sleep event cancels its wake family");

const completed = { ...state, events: [{ ...sleepSoon, done: true }, sleepLater, shift, gym] };
assert(
  !buildAlarmKitItems(completed, now).items.some((i) => i.eventId === "s1"),
  "Completing the sleep event cancels its wake family"
);

const edited = { ...state, events: [{ ...sleepSoon, end: at(2) }, sleepLater, shift, gym] };
assert(
  buildAlarmKitItems(edited, now).nearestWake.at.getTime() === Date.parse(at(2)),
  "Editing the sleep end updates the wake time"
);

const flood = {
  settings,
  events: [
    sleepSoon,
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `w${i}`,
      title: `Shift ${i}`,
      kind: "work",
      category: "work",
      start: at(i + 2),
      end: at(i + 10),
    })),
  ],
  notes: [],
};
const capped = buildAlarmKitItems(flood, now);
assert(capped.reserved === 2 + ALARM_TEST_SLOTS, "Backup slots and the test-alarm slot are reserved first");
assert(
  capped.primaries.length + capped.backups.length <= ALARM_PLAN_CAP,
  `AlarmKit total stays within ${ALARM_PLAN_CAP}`
);
assert(capped.capped.length > 0, "Overflow primaries are reported as capped, not dropped silently");
assert(
  capped.capped.every((p) => p.role === "shift"),
  "Capped items are ordinary primaries, not the reserved backups"
);
assert(capped.backups.length === 2, "Reserved backups still exist after the cap");
assert(capped.nearestWake?.eventId === "s1", "The nearest wake is kept so it can be protected");
assert(
  capped.primaries.length === ALARM_PLAN_CAP - capped.reserved,
  "Primary budget is cap minus reserved backup and test slots"
);

const store = createAlarmStore([
  { id: kit.nearestWake.id },
  { id: backupAlarmId(kit.nearestWake.id, 1) },
  { id: backupAlarmId(kit.nearestWake.id, 2) },
]);
const stopped = applySystemStop(store, kit.nearestWake.id);
assert(!store.has(kit.nearestWake.id), "System Stop may stop the current alarm");
assert(
  store.has(backupAlarmId(kit.nearestWake.id, 1)) && store.has(backupAlarmId(kit.nearestWake.id, 2)),
  "System Stop leaves backup alarms"
);
assert(stopped.remaining.length === 2, "Two backups remain after system Stop");

assert(applyWrongAnswer(store).remaining.length === 2, "A wrong answer cancels nothing");
assert(applyForceClose(store).remaining.length === 2, "Force-closing the app does not cancel backups");

applyVerificationSuccess(store, kit.nearestWake.id);
assert(!store.list().length, "Correct verification cancels primary and backups");

const regen = createAlarmStore();
const ids = protectionSet(kit.nearestWake.id, 2);
syncProtection(regen, ids);
syncProtection(regen, ids);
assert(
  regen.list().map((a) => a.id).sort().join() === ids.slice().sort().join(),
  "A second sync of the same identities does not duplicate"
);

const plan = buildPlan(state, now);
const backupsInPlan = plan.filter((p) => p.kind === "wake-backup");
assert(backupsInPlan.length === 2, "Fallback local-notification plan also carries nearest-wake backups");
assert(
  buildAlarmPlan(state, now).every((p) => !isBackupAlarmId(p.id)),
  "buildAlarmPlan strips backups so the AlarmKit cap can reserve them"
);

if (failed) {
  console.error(`\n${failed} wake-protection check(s) failed`);
  process.exit(1);
}
console.log("\nAll wake-protection checks passed");
