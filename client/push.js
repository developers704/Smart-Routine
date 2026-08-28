function isStandalonePwa() {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  if (window.navigator.standalone === true) return true;
  return false;
}

function urlBase64ToUint8Array(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const str = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(str);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
}

/** iOS needs home-screen install + granted permission before push works in background. */
export async function setupWebPush() {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (Notification.permission !== "granted") return { ok: false, reason: "denied" };
  if (!isStandalonePwa()) return { ok: false, reason: "not-standalone" };

  const keyRes = await fetch("/api/push/vapid-public-key");
  if (!keyRes.ok) return { ok: false, reason: "no-server" };
  const { publicKey } = await keyRes.json();
  if (!publicKey) return { ok: false, reason: "no-vapid" };

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const saveRes = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub),
  });
  return { ok: saveRes.ok, reason: saveRes.ok ? "subscribed" : "save-failed" };
}
