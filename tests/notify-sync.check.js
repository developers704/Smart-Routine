/**
 * Exercises scheduleNative() against a fake Capacitor LocalNotifications plugin,
 * covering the sync paths the iPhone depends on: startup, regeneration,
 * edit, delete and completion.
 */
import { buildNotificationPlan, scheduleNative } from "../client/alarms.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

function fakePlugin({ failOnSchedule = false } = {}) {
  const pending = new Map();
  return {
    calls: { schedule: 0, cancel: 0, getPending: 0 },
    pending,
    async getPending() {
      this.calls.getPending++;
      return { notifications: [...pending.values()] };
    },
    async schedule({ notifications }) {
      this.calls.schedule++;
      if (failOnSchedule) throw new Error("simulated schedule failure");
      for (const n of notifications) pending.set(Number(n.id), { ...n, id: Number(n.id) });
    },
    async cancel({ notifications }) {
      this.calls.cancel++;
      for (const n of notifications) pending.delete(Number(n.id));
    },
    ids() {
      return [...pending.keys()].sort((a, b) => a - b);
    },
  };
}

const now = Date.now();
const at = (h) => new Date(now + h * 3600000).toISOString();

const settings = { alarmLeadMin: 10, notepadRemindMin: 21 * 60 + 30 };
const gym = { id: "g1", title: "Gym", kind: "gym", category: "gym", start: at(3), end: at(4) };
const shift = { id: "w1", title: "Shift Morning", kind: "work", category: "work", start: at(5), end: at(13) };
const baseState = { settings, events: [gym, shift], notes: [] };

// --- startup sync ---------------------------------------------------------
const api = fakePlugin();
const first = await scheduleNative(baseState, api);
const plannedIds = buildNotificationPlan(baseState).map((p) => p.nativeId).sort((a, b) => a - b);
assert(first.ok, "Startup sync succeeds");
assert(first.scheduled === plannedIds.length, `Startup schedules the whole plan (got ${first.scheduled})`);
assert(api.ids().join() === plannedIds.join(), "Pending notifications match the plan");

// --- duplicate prevention -------------------------------------------------
const second = await scheduleNative(baseState, api);
assert(second.scheduled === 0, `Re-syncing schedules nothing new (got ${second.scheduled})`);
assert(second.cancelled === 0, "Re-syncing cancels nothing");
assert(api.ids().join() === plannedIds.join(), "Pending set is unchanged after a duplicate sync");
assert(api.calls.schedule === 1, "No redundant schedule call on an unchanged plan");

// --- event edit -----------------------------------------------------------
const movedState = { ...baseState, events: [{ ...gym, start: at(6), end: at(7) }, shift] };
const moved = await scheduleNative(movedState, api);
const movedIds = buildNotificationPlan(movedState).map((p) => p.nativeId).sort((a, b) => a - b);
assert(moved.cancelled === 2, `Editing a time cancels the stale items (got ${moved.cancelled})`);
assert(moved.scheduled === 2, `Editing a time schedules the new items (got ${moved.scheduled})`);
assert(api.ids().join() === movedIds.join(), "Pending set follows the edited event");

// --- completion cancels ---------------------------------------------------
const doneState = { ...movedState, events: [{ ...movedState.events[0], done: true }, shift] };
const completed = await scheduleNative(doneState, api);
const doneIds = buildNotificationPlan(doneState).map((p) => p.nativeId).sort((a, b) => a - b);
assert(completed.cancelled === 2, `Completing an event cancels its items (got ${completed.cancelled})`);
assert(api.ids().join() === doneIds.join(), "Completed event leaves nothing pending");
assert(api.ids().length > 0, "Other events stay scheduled after one completion");

// --- deletion cancels -----------------------------------------------------
const deletedState = { ...baseState, events: [shift] };
const deleted = await scheduleNative(deletedState, api);
assert(
  api.ids().join() === buildNotificationPlan(deletedState).map((p) => p.nativeId).sort((a, b) => a - b).join(),
  "Deleting an event leaves only the remaining plan pending"
);
assert(deleted.ok, "Deletion sync reports success");

// --- alarm-off cancels ----------------------------------------------------
const silenced = { ...baseState, events: [{ ...gym, alarm: false }, shift] };
await scheduleNative(silenced, api);
const gymNativeIds = buildNotificationPlan(baseState)
  .filter((p) => p.eventId === "g1")
  .map((p) => p.nativeId);
assert(
  gymNativeIds.every((id) => !api.ids().includes(id)),
  "Turning an event's alarm off cancels its pending notifications"
);

// --- regeneration does not duplicate -------------------------------------
const regen = fakePlugin();
await scheduleNative(baseState, regen);
const afterFirst = regen.ids().join();
await scheduleNative(baseState, regen);
await scheduleNative(baseState, regen);
assert(regen.ids().join() === afterFirst, "Repeated regeneration keeps the pending set identical");

// --- failure is reported, not swallowed ----------------------------------
const broken = fakePlugin({ failOnSchedule: true });
const brokenRes = await scheduleNative(baseState, broken);
assert(brokenRes.ok === false, "A failing plugin returns ok:false");
assert(brokenRes.reason === "schedule-failed", `Failure reason is surfaced (got ${brokenRes.reason})`);
assert(Boolean(brokenRes.error), "Failure includes an error message");

const noPlugin = await scheduleNative(baseState, null);
assert(noPlugin.ok === false && noPlugin.reason === "no-plugin", "Missing plugin is reported clearly");

if (failed) {
  console.error(`\n${failed} notification sync check(s) failed`);
  process.exit(1);
}
console.log("\nAll notification sync checks passed");
