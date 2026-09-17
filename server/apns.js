import { createPrivateKey, createSign } from "node:crypto";

const TOKEN_TTL_MS = 50 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Convert DER ECDSA signature to raw R||S for ES256 JWT. */
export function derEcdsaToJose(der) {
  const buf = Buffer.from(der);
  let i = 0;
  if (buf[i++] !== 0x30) throw new Error("invalid-der");
  let seqLen = buf[i++];
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    seqLen = 0;
    for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | buf[i++];
  }
  const readInt = () => {
    if (buf[i++] !== 0x02) throw new Error("invalid-der-int");
    let n = buf[i++];
    let start = i;
    i += n;
    while (n > 32 && buf[start] === 0) {
      start++;
      n--;
    }
    const out = Buffer.alloc(32);
    buf.copy(out, 32 - Math.min(n, 32), start, start + Math.min(n, 32));
    return out;
  };
  return Buffer.concat([readInt(), readInt()]);
}

export function createApnsJwt({ p8, keyId, teamId, now = Date.now() } = {}) {
  if (!p8 || !keyId || !teamId) return { ok: false, error: "apns-not-configured" };
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const unsigned = `${header}.${payload}`;
  const key = createPrivateKey(p8);
  const der = createSign("SHA256").update(unsigned).sign(key);
  const sig = b64url(derEcdsaToJose(der));
  return { ok: true, jwt: `${unsigned}.${sig}` };
}

export function isLikelyApnsDeviceToken(token) {
  return typeof token === "string" && /^[0-9a-f]{64,200}$/i.test(token.trim());
}

export function createApnsSender({
  p8,
  keyId,
  teamId,
  bundleId,
  production = false,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  let cached = null;
  const host = production ? "api.push.apple.com" : "api.sandbox.push.apple.com";

  async function jwt() {
    if (cached && now() - cached.at < TOKEN_TTL_MS) return { ok: true, jwt: cached.jwt };
    const out = createApnsJwt({ p8, keyId, teamId, now: now() });
    if (!out.ok) return out;
    cached = { jwt: out.jwt, at: now() };
    return out;
  }

  async function send({ deviceToken, title, body, sound = true }) {
    if (!isLikelyApnsDeviceToken(deviceToken)) return { ok: false, error: "invalid-token" };
    const auth = await jwt();
    if (!auth.ok) return auth;
    if (!bundleId) return { ok: false, error: "apns-not-configured" };
    const url = `https://${host}/3/device/${deviceToken.trim()}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `bearer ${auth.jwt}`,
        "apns-topic": bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        aps: {
          alert: { title, body },
          sound: sound ? "default" : undefined,
        },
      }),
    });
    if (res.status === 200) return { ok: true };
    const errBody = await res.text().catch(() => "");
    const invalid = res.status === 410 || /BadDeviceToken|Unregistered/i.test(errBody);
    return { ok: false, status: res.status, error: invalid ? "invalid-token" : "apns-failed", invalid };
  }

  return { send, configured: Boolean(p8 && keyId && teamId && bundleId) };
}
