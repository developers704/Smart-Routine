import { isNative } from "./native.js";
import { setupWebPush } from "./push.js";

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
  localStorage.setItem("routine-hide-install", "1");
  emit();
}

export function installMode() {
  if (isStandalone()) return "installed";
  if (localStorage.getItem("routine-hide-install") === "1") return "hidden";
  if (isIos()) return "ios";
  if (deferredPrompt) return "chrome";
  return "hint";
}

export function bannerHtml() {
  const mode = installMode();
  if (mode === "installed" || mode === "hidden") return "";
  if (mode === "ios") {
    return `<aside class="install" id="installBanner">
      <div>
        <strong>Add to your iPhone</strong>
        <p>1. Safari Share → <b>Add to Home Screen</b><br>
        2. Open <b>Smart Routine</b> from that home screen icon (not Safari)<br>
        3. Tap <b>Enable alarms</b> and allow notifications</p>
        <p class="muted small">iPhone tip: PWAs stay on your Home Screen — they don’t appear in App Library like App Store apps.</p>
      </div>
      <div class="row">
        <button class="btn primary" id="installNotify">Enable alarms</button>
        <button class="btn ghost" id="installHide">Later</button>
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
  const reg = await navigator.serviceWorker?.ready;
  await (reg?.showNotification?.("Alarms are on", {
    body: push.ok
      ? "You’ll get pings before events — even when the app is closed."
      : isStandalone()
        ? "Open from your Home Screen icon, then tap Enable alarms again."
        : "Add to Home Screen first, open from the icon, then enable alarms.",
    icon: "/icons/icon-192.png",
  }) || Promise.resolve());
  return push;
}

async function afterInstalled() {
  localStorage.setItem("routine-pwa-installed", "1");
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    await Notification.requestPermission();
  }
  if (isStandalone() && Notification.permission === "granted") {
    await setupWebPush();
  }
  const reg = await navigator.serviceWorker?.ready.catch(() => null);
  if (reg && Notification.permission === "granted") {
    await reg.showNotification("Smart Routine installed", {
      body: "Open it from your home screen. Tap Enable alarms if you haven’t yet.",
      icon: "/icons/icon-192.png",
      tag: "routine-installed",
    });
  }
}

export function bindInstallBanner(root) {
  root.querySelector("#installHide")?.addEventListener("click", hideInstall);
  root.querySelector("#installBtn")?.addEventListener("click", () => clickInstall());
  root.querySelector("#installNotify")?.addEventListener("click", () => enableAlarmsFromBanner());
}
