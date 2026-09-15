import { isNative, plugin } from "./native.js";
import { familyPostLocation, familySetSharing } from "./family-api.js";

function api() {
  return plugin("FamilyLocation");
}

export async function familyLocationStatus() {
  if (!isNative()) {
    const perm = typeof navigator !== "undefined" ? navigator.permissions : null;
    return { supported: false, authorization: "unavailable", reason: "not-native", web: Boolean(perm) };
  }
  const FamilyLocation = api();
  if (!FamilyLocation?.getStatus) return { supported: false, authorization: "unavailable", reason: "no-plugin" };
  try {
    return await FamilyLocation.getStatus();
  } catch (err) {
    return { supported: false, authorization: "unavailable", reason: String(err?.message || err) };
  }
}

export async function requestWhenInUseLocation() {
  const FamilyLocation = api();
  if (FamilyLocation?.requestWhenInUse) return FamilyLocation.requestWhenInUse();
  if (!navigator.geolocation) return { ok: false, authorization: "denied" };
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve({ ok: true, authorization: "whenInUse" }),
      () => resolve({ ok: false, authorization: "denied" }),
      { enableHighAccuracy: false, timeout: 8000 }
    );
  });
}

export async function requestAlwaysLocation() {
  const FamilyLocation = api();
  if (!FamilyLocation?.requestAlways) return { ok: false, error: "when-in-use-first", reason: "no-plugin" };
  return FamilyLocation.requestAlways();
}

let watchId = null;
let nativeHandle = null;

export async function startFamilyLocationSharing() {
  const FamilyLocation = api();
  if (FamilyLocation?.startUpdating) {
    if (!nativeHandle && FamilyLocation.addListener) {
      nativeHandle = await FamilyLocation.addListener("location", (point) => {
        familyPostLocation(point).catch(() => {});
      });
    }
    const status = await FamilyLocation.startUpdating();
    await familySetSharing({ paused: false, permission: "authorized" });
    return status;
  }
  if (!navigator.geolocation) return { ok: false };
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      familyPostLocation({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: new Date(pos.timestamp).toISOString(),
      }).catch(() => {});
    },
    () => {},
    { enableHighAccuracy: false, maximumAge: 30_000 }
  );
  await familySetSharing({ paused: false, permission: "authorized" });
  return { ok: true, authorization: "whenInUse" };
}

export async function stopFamilyLocationSharing({ paused = false, permission } = {}) {
  const FamilyLocation = api();
  if (FamilyLocation?.stopUpdating) await FamilyLocation.stopUpdating();
  if (watchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  await familySetSharing({ paused, permission: permission || (paused ? undefined : "authorized") });
}
