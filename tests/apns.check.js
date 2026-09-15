import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createApnsJwt, createApnsSender, derEcdsaToJose, isLikelyApnsDeviceToken } from "../server/apns.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

assert(!isLikelyApnsDeviceToken("short"), "Short APNs tokens are rejected");
assert(isLikelyApnsDeviceToken("ab".repeat(32)), "64-hex tokens are accepted");

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const p8 = privateKey.export({ type: "pkcs8", format: "pem" });
const jwt = createApnsJwt({ p8, keyId: "KEY1", teamId: "TEAM1" });
assert(jwt.ok && jwt.jwt.split(".").length === 3, "APNs JWT is ES256 with three parts");

try {
  derEcdsaToJose(Buffer.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]));
  assert(true, "Tiny DER integers convert");
} catch {
  assert(false, "Tiny DER integers convert");
}

const goneTok = "aa".repeat(32);
const sender = createApnsSender({
  p8,
  keyId: "KEY1",
  teamId: "TEAM1",
  bundleId: "app.routine.calendar",
  fetchImpl: async (url) => {
    if (url.includes(goneTok)) return { status: 410, text: async () => "Unregistered" };
    return { status: 200, text: async () => "" };
  },
});
const token = randomBytes(32).toString("hex");
const ok = await sender.send({ deviceToken: token, title: "Away", body: "test" });
assert(ok.ok, "Valid-looking token can be posted to the APNs client");
const bad = await sender.send({ deviceToken: goneTok, title: "Away", body: "test" });
assert(bad.invalid && bad.error === "invalid-token", "410 Unregistered is treated as an invalid token");

if (failed) {
  console.error(`\n${failed} APNs check(s) failed`);
  process.exit(1);
}
console.log("\nAll APNs checks passed");
