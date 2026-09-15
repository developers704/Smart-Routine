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
      reason: support.reason || status.reason || null,
      osVersion: support.osVersion || null,
    };
  } catch {
    return emptyStatus({ reason: "plugin-error" });
  }
}

export async function enableScreenTime() {
  const ScreenTime = api();
  if (!ScreenTime?.requestAuthorization) return emptyStatus({ reason: "no-plugin" });
  try {
    return await ScreenTime.requestAuthorization();
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

export function afterLayout() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

/** CSS box for the native overlay, clipped so it never covers the nav or chips. */
export function activityReportFrame(host, nav = document.querySelector("nav.nav")) {
  if (!host) return null;
  const r = host.getBoundingClientRect();
  const navTop = nav ? nav.getBoundingClientRect().top : (typeof window !== "undefined" ? window.innerHeight : 0);
  const top = Math.max(0, r.top);
  const bottom = Math.min(r.bottom, navTop - 8);
  const left = Math.max(0, r.left);
  const right = Math.min(r.right, typeof window !== "undefined" ? window.innerWidth : r.right);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  if (width < 24 || height < 24) return null;
  return { top, left, width, height };
}

let overlayCleanup = null;

function stopOverlayTracking() {
  if (overlayCleanup) {
    overlayCleanup();
    overlayCleanup = null;
  }
}

function startOverlayTracking(host, range) {
  stopOverlayTracking();
  const ScreenTime = api();
  if (!ScreenTime?.updateReportFrame) return;
  let ticking = false;
  const send = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(async () => {
      ticking = false;
      const frame = activityReportFrame(host);
      if (!frame) return;
      try {
        await ScreenTime.updateReportFrame({ range, ...frame });
      } catch {
        /* overlay already gone */
      }
    });
  };
  window.addEventListener("scroll", send, true);
  window.addEventListener("resize", send);
  window.visualViewport?.addEventListener("resize", send);
  window.visualViewport?.addEventListener("scroll", send);
  overlayCleanup = () => {
    window.removeEventListener("scroll", send, true);
    window.removeEventListener("resize", send);
    window.visualViewport?.removeEventListener("resize", send);
    window.visualViewport?.removeEventListener("scroll", send);
  };
}

export async function attachScreenTimeReport(range, host) {
  const ScreenTime = api();
  if (!ScreenTime?.attachReport || !host) return { ok: false };
  await afterLayout();
  const frame = activityReportFrame(host);
  if (!frame) return { ok: false, reason: "no-frame" };
  try {
    const out = await ScreenTime.attachReport({
      range: range === "week" ? "week" : "today",
      ...frame,
    });
    startOverlayTracking(host, range === "week" ? "week" : "today");
    return out;
  } catch {
    return { ok: false };
  }
}

export async function detachScreenTimeReport() {
  stopOverlayTracking();
  const ScreenTime = api();
  if (!ScreenTime?.detachReport) return;
  try {
    await ScreenTime.detachReport();
  } catch {
    /* overlay already gone */
  }
}
