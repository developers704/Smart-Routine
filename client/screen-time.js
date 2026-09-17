import { isNative, plugin } from "./native.js";

function api() {
  return plugin("ScreenTime");
}

function emptyStatus(extra = {}) {
  return {
    supported: false,
    authorization: "unavailable",
    hasSelection: false,
    reason: extra.reason || "unavailable",
    ...extra,
  };
}

export async function screenTimeStatus() {
  if (!isNative()) return emptyStatus({ reason: "not-native" });
  const ScreenTime = api();
  if (!ScreenTime?.getAuthorizationStatus) return emptyStatus({ reason: "no-plugin" });
  try {
    const status = await ScreenTime.getAuthorizationStatus();
    const support = ScreenTime.isSupported ? await ScreenTime.isSupported() : {};
    return {
      supported: Boolean(support.supported),
      authorization: status.authorization || "unavailable",
      hasSelection: Boolean(status.hasSelection),
      users: status.users || support.users || "all",
      familySharingRequired: Boolean(status.familySharingRequired),
      reason: support.reason || status.reason || null,
      osVersion: support.osVersion || null,
    };
  } catch {
    return emptyStatus({ reason: "plugin-error" });
  }
}

export async function enableScreenTime(opts = {}) {
  const ScreenTime = api();
  if (!ScreenTime?.requestAuthorization) return emptyStatus({ reason: "no-plugin" });
  try {
    return await ScreenTime.requestAuthorization({ member: opts.member || "individual" });
  } catch (err) {
    return emptyStatus({ reason: String(err?.message || err) });
  }
}

export async function chooseScreenTimeApps() {
  const ScreenTime = api();
  if (!ScreenTime?.presentActivityPicker) return { ok: false, reason: "no-plugin" };
  try {
    return await ScreenTime.presentActivityPicker();
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

export async function attachScreenTimeReport(range, host) {
  const ScreenTime = api();
  if (!ScreenTime?.attachReport || !host) return { ok: false };
  const rect = host.getBoundingClientRect();
  try {
    return await ScreenTime.attachReport({
      range: range === "week" ? "week" : "today",
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    });
  } catch {
    return { ok: false };
  }
}

export async function detachScreenTimeReport() {
  const ScreenTime = api();
  if (!ScreenTime?.detachReport) return;
  try {
    await ScreenTime.detachReport();
  } catch {
    /* overlay already gone */
  }
}
