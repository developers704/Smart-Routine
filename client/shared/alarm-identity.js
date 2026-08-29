/**
 * Deterministic AlarmKit UUIDs from Smart Routine plan ids.
 *
 * The same event/role/time identity must map to the same UUID across plan
 * regeneration, app restarts and device restarts. UUID v5 (SHA-1, RFC 4122)
 * is used so the Swift plugin can reproduce the exact same bytes.
 */

import { createHash } from "node:crypto";

/** Fixed namespace — must match RoutineAlarmIdentity.namespace in Swift. */
export const ALARM_UUID_NAMESPACE = "6dc9a1a0-5e11-4111-9c0d-0000006dc901";

export const TEST_ALARM_ID = "routine-test-alarm";

export function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`invalid uuid: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToUuid(bytes) {
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** RFC 4122 UUID v5. */
export function uuidv5(name, namespace = ALARM_UUID_NAMESPACE) {
  const ns = uuidToBytes(namespace);
  const hash = createHash("sha1");
  hash.update(Buffer.from(ns));
  hash.update(String(name), "utf8");
  const bytes = Uint8Array.from(hash.digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

export function uuidFromPlanId(planId) {
  if (!planId || typeof planId !== "string") throw new Error("plan id is required");
  return uuidv5(planId);
}

export function testAlarmUuid() {
  return uuidFromPlanId(TEST_ALARM_ID);
}
