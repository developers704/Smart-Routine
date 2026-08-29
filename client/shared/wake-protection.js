/**
 * In-memory model of primary + backup wake protection.
 *
 * Used by tests to prove: backups survive system Stop, verification cancels
 * every associated alarm, edits/deletes/completes clean up, regeneration does
 * not duplicate, and normal snooze never overlaps math verification.
 */

import { backupAlarmId, isBackupAlarmId, primaryIdOfBackup } from "./alarm-plan.js";

export function protectionSet(primaryId, backupCount) {
  const ids = [primaryId];
  for (let i = 1; i <= backupCount; i++) ids.push(backupAlarmId(primaryId, i));
  return ids;
}

export function createAlarmStore(entries = []) {
  const scheduled = new Map(entries.map((e) => [e.id, { ...e, cancelled: false }]));
  return {
    scheduled,
    list() {
      return [...scheduled.values()].filter((a) => !a.cancelled);
    },
    has(id) {
      return scheduled.has(id) && !scheduled.get(id).cancelled;
    },
    schedule(entry) {
      scheduled.set(entry.id, { ...entry, cancelled: false });
    },
    cancel(id) {
      const cur = scheduled.get(id);
      if (cur) cur.cancelled = true;
    },
    cancelFamily(primaryId) {
      for (const a of scheduled.values()) {
        if (a.id === primaryId || primaryIdOfBackup(a.id) === primaryId) a.cancelled = true;
      }
    },
  };
}

/**
 * System Stop dismisses the currently alerting alarm only. Backups stay.
 * Never treat this as "uninterruptible".
 */
export function applySystemStop(store, alertingId) {
  if (store.has(alertingId)) store.cancel(alertingId);
  return {
    stopped: alertingId,
    remaining: store.list().map((a) => a.id),
  };
}

export function applyVerificationSuccess(store, primaryId) {
  store.cancelFamily(primaryId);
  return { cancelled: protectionSet(primaryId, 3).filter((id) => !store.has(id)) };
}

export function applyWrongAnswer(store) {
  return { remaining: store.list().map((a) => a.id) };
}

/** Force-closing the app must not cancel backups. */
export function applyForceClose(store) {
  return { remaining: store.list().map((a) => a.id) };
}

export function syncProtection(store, nextIds) {
  const wanted = new Set(nextIds);
  for (const a of store.list()) {
    if (!wanted.has(a.id)) store.cancel(a.id);
  }
  for (const id of nextIds) {
    if (!store.has(id)) store.schedule({ id, snooze: !isBackupAlarmId(id) && !id.endsWith(":protected") });
  }
  return store.list().map((a) => a.id).sort();
}

export function snoozeAndMathOverlap(items = []) {
  return items.some((i) => i.protected && i.snooze);
}
