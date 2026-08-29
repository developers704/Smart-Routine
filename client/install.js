import { isNative } from "./native.js";
import { setupWebPush } from "./push.js";
import { refreshTickGate } from "./routine-alarms.js";

let deferredPrompt = null;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn();
}

export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isStandalone() {
  if (isNative()) return true;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  if (window.navigator.standalone === true) return true;
  return false;
}

export function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function notificationPermission() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export function needsAlarmSetup() {
  if (isNative()) return false;
  if (!isStandalone()) return false;
  if (notificationPermission() === "unsupported") return false;
  if (localStorage.getItem("routine-hide-alarms") === "1") return false;
  if (notificationPermission() !== "granted") return true;
  return localStorage.getItem("routine-alarms-enabled") !== "1";
}

export function setupInstall() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    emit();
  });
  window.addEventListener("appinstalled", async () => {
    deferredPrompt = null;
    localStorage.setItem("routine-pwa-installed", "1");
    localStorage.removeItem("routine-hide-install");
    await afterInstalled();
    emit();
  });
}

export function hideInstall() {
  if (needsAlarmSetup() || installMode() === "alarms") {
    localStorage.setItem("routine-hide-alarms", "1");
  } else {
    localStorage.setItem("routine-hide-install", "1");
  }
  emit();
}

export function installMode() {
  if (needsAlarmSetup()) return "alarms";
  if (isStandalone()) return "installed";
  if (localStorage.getItem("routine-hide-install") === "1") return "hidden";
  if (isIos()) return "ios";
  if (deferredPrompt) return "chrome";
  return "hint";
}

function alarmsBannerHtml() {
  const perm = notificationPermission();
  const denied = perm === "denied";
  return `<aside class="install" id="installBanner">
    <div>
      <strong>Enable alarms</strong>
      <p>${
        denied
          ? "Notifications are blocked. Open <b>Settings → Smart Routine → Notifications</b> and allow them, then come back and tap the button below."
          : "Allow notifications for shift, meal, study, and leave-time pings — even when the app is closed."
      }</p>
    </div>
    <div class="row">
      <button class="btn primary" id="installNotify">${denied ? "Try again" : "Enable alarms"}</button>
      <button class="btn ghost" id="installHide">Later</button>
    </div>
  </aside>`;
}

export function bannerHtml() {
  const mode = installMode();
  if (mode === "installed" || mode === "hidden") return "";
  if (mode === "alarms") return alarmsBannerHtml();
  if (mode === "ios") {
    return `<aside class="install" id="installBanner">
      <div>
        <strong>Add to your iPhone</strong>
        <p>1. Tap <b>Share</b> → <b>Add to Home Screen</b><br>
        2. Open <b>Smart Routine</b> from that home screen icon (not Safari)<br>
        3. Tap <b>Enable alarms</b> inside the app</p>
        <p class="muted small">iPhone tip: PWAs stay on your Home Screen — they don’t appear in App Library like App Store apps.</p>
      </div>
      <div class="row">
        <button class="btn ghost" id="installHide">Got it</button>
      </div>
    </aside>`;
  }
  return `<aside class="install" id="installBanner">
    <div>
      <strong>Install Smart Routine</strong>
      <p>Add it to your home screen and use it as an app — shifts, checklist, notes, and alarms.</p>
    </div>
    <div class="row">
      <button class="btn primary" id="installBtn">${mode === "chrome" ? "Download app" : "Install"}</button>
      <button class="btn ghost" id="installHide">Later</button>
    </div>
  </aside>`;
}

export async function clickInstall() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (outcome === "accepted") await afterInstalled();
    emit();
    return;
  }
  if (isIos()) return;
  alert("Use the browser menu to Install app / Add to Home Screen, then open Smart Routine from the icon.");
}

export async function enableAlarmsFromBanner() {
  if (typeof Notification === "undefined") return { ok: false, reason: "unsupported" };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, reason: "denied" };
  const push = await setupWebPush();
  if (perm === "granted") {
    localStorage.setItem("routine-alarms-enabled", "1");
    localStorage.removeItem("routine-hide-alarms");
  }
  await refreshTickGate();
  const reg = await navigator.serviceWorker?.ready;
  await (reg?.showNotification?.("Alarms are on", {
    body: push.ok
      ? "You’ll get pings before events — even when the app is closed."
      : "Notifications allowed. If pings don’t arrive, open Set → Enable alarms again.",
    icon: "/icons/icon-192.png",
  }) || Promise.resolve());
  emit();
  return push;
}

async function afterInstalled() {
  localStorage.setItem("routine-pwa-installed", "1");
  emit();
}

export function bindInstallBanner(root) {
  root.querySelector("#installHide")?.addEventListener("click", hideInstall);
  root.querySelector("#installBtn")?.addEventListener("click", () => clickInstall());
  root.querySelector("#installNotify")?.addEventListener("click", async () => {
    await enableAlarmsFromBanner();
  });
}

export function alarmsStatusLabel() {
  const perm = notificationPermission();
  if (perm === "unsupported") return "Not supported in this browser";
  if (!isStandalone()) return "Add to Home Screen first, then enable here";
  if (perm === "denied") return "Blocked — allow in iPhone Settings";
  if (perm === "granted" && localStorage.getItem("routine-alarms-enabled") === "1") return "On";
  return "Off — tap below to enable";
}
