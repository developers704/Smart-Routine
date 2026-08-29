export function isStandalonePwa() {
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  return window.navigator.standalone === true;
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

export async function subscriptionEndpoint() {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub?.endpoint || null;
  } catch {
    return null;
  }
}

export async function pushStatus() {
  if (!pushSupported()) return { supported: false, subscribed: false, reason: "unsupported" };
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    let devices = null;
    try {
      const res = await fetch("/api/push/status");
      if (res.ok) devices = (await res.json()).devices ?? null;
    } catch {
      /* offline */
    }
    return {
      supported: true,
      subscribed: Boolean(sub),
      standalone: isStandalonePwa(),
      devices,
    };
  } catch (err) {
    return { supported: true, subscribed: false, reason: String(err?.message || err) };
  }
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
