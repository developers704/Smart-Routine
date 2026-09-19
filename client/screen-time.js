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

const MIN_FRAME = 32;

let tracked = {
  host: null,
  range: "today",
  raf: 0,
  ro: null,
  listening: false,
};

function navTop() {
  const nav = document.querySelector("nav.nav");
  return nav ? nav.getBoundingClientRect().top : window.innerHeight;
}

/** Clip a host rect so the native overlay cannot cover the nav or leave the viewport. */
export function clipReportRect(rect, navTop, viewW, viewH) {
  const top = Math.max(0, rect.top);
  const bottom = Math.min(rect.bottom, navTop, viewH);
  const left = Math.max(0, rect.left);
  const right = Math.min(rect.right, viewW);
  return {
    top,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** Viewport rect for the native overlay, clipped so it cannot cover the nav or page chrome. */
export function reportHostFrame(host) {
  return clipReportRect(host.getBoundingClientRect(), navTop(), window.innerWidth, window.innerHeight);
}

function afterLayout() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

async function detachOnly() {
  const ScreenTime = api();
  if (!ScreenTime?.detachReport) return;
  try {
    await ScreenTime.detachReport();
  } catch {
    /* overlay already gone */
  }
}

async function pushFrame(host, range) {
  const ScreenTime = api();
  if (!ScreenTime?.attachReport) return { ok: false };
  const frame = reportHostFrame(host);
  if (frame.width < MIN_FRAME || frame.height < MIN_FRAME) {
    await detachOnly();
    return { ok: false, reason: "clipped" };
  }
  try {
    return await ScreenTime.attachReport({
      range: range === "week" ? "week" : "today",
      top: frame.top,
      left: frame.left,
      width: frame.width,
      height: frame.height,
    });
  } catch {
    return { ok: false };
  }
}

function schedulePush() {
  if (tracked.raf) return;
  tracked.raf = requestAnimationFrame(() => {
    tracked.raf = 0;
    if (tracked.host?.isConnected) void pushFrame(tracked.host, tracked.range);
  });
}

function bindTracking() {
  if (tracked.listening) return;
  tracked.listening = true;
  window.addEventListener("scroll", schedulePush, { capture: true, passive: true });
  window.addEventListener("resize", schedulePush);
  window.visualViewport?.addEventListener("resize", schedulePush);
  window.visualViewport?.addEventListener("scroll", schedulePush);
}

function unbindTracking() {
  if (!tracked.listening) return;
  tracked.listening = false;
  window.removeEventListener("scroll", schedulePush, { capture: true });
  window.removeEventListener("resize", schedulePush);
  window.visualViewport?.removeEventListener("resize", schedulePush);
  window.visualViewport?.removeEventListener("scroll", schedulePush);
  if (tracked.raf) {
    cancelAnimationFrame(tracked.raf);
    tracked.raf = 0;
  }
}

export async function attachScreenTimeReport(range, host) {
  const ScreenTime = api();
  if (!ScreenTime?.attachReport || !host) return { ok: false };
  tracked.host = host;
  tracked.range = range === "week" ? "week" : "today";
  await afterLayout();
  if (!host.isConnected) return { ok: false };
  const first = await pushFrame(host, tracked.range);
  if (!tracked.ro) tracked.ro = new ResizeObserver(schedulePush);
  tracked.ro.disconnect();
  tracked.ro.observe(host);
  bindTracking();
  return first;
}

export async function detachScreenTimeReport() {
  unbindTracking();
  tracked.ro?.disconnect();
  tracked.host = null;
  await detachOnly();
}
