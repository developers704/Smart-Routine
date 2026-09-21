import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/** scrypt params: unique salt per hash. N=16384 is the Node default cost floor we keep. */
export const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, saltBytes: 16 };

const DUMMY = scryptAsync(randomBytes(32), randomBytes(SCRYPT.saltBytes), SCRYPT.keylen, {
  N: SCRYPT.N,
  r: SCRYPT.r,
  p: SCRYPT.p,
});

/** Temporary test logins may be 6 characters (e.g. 123456). Raise this again when those hashes are replaced. */
export const MIN_PASSWORD_LENGTH = 6;

export async function hashPassword(password) {
  const pwd = String(password || "");
  if (pwd.length < MIN_PASSWORD_LENGTH || pwd.length > 200) return { ok: false, error: "invalid-password" };
  const salt = randomBytes(SCRYPT.saltBytes);
  const hash = await scryptAsync(pwd, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return {
    ok: true,
    hash: `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${Buffer.from(hash).toString("base64")}`,
  };
}

export function parsePasswordHash(stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return null;
  return { N, r, p, salt: Buffer.from(parts[4], "base64"), hash: Buffer.from(parts[5], "base64") };
}

export async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  const pwd = String(password || "");
  if (!parsed || parsed.hash.length !== SCRYPT.keylen) {
    await DUMMY;
    return false;
  }
  const check = await scryptAsync(pwd, parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
  });
  const left = Buffer.from(check);
  if (left.length !== parsed.hash.length) return false;
  return timingSafeEqual(left, parsed.hash);
}
