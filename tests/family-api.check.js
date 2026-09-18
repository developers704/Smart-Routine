import { FAMILY_API_NATIVE_ORIGIN, familyApiOrigin } from "../client/family-api.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

assert(FAMILY_API_NATIVE_ORIGIN === "https://smartroutine.valliani.app", "Native family API origin is the VPS");
assert(familyApiOrigin() === "", "Browser/PWA keeps same-origin family API paths");

const prev = globalThis.Capacitor;
globalThis.Capacitor = { isNativePlatform: () => true };
assert(familyApiOrigin() === FAMILY_API_NATIVE_ORIGIN, "Xcode/Capacitor builds send family login to the VPS");
globalThis.Capacitor = { isNativePlatform: () => false };
assert(familyApiOrigin() === "", "Non-native Capacitor stub still uses relative paths");
globalThis.Capacitor = prev;

if (failed) {
  console.error(`\n${failed} family-api check(s) failed`);
  process.exit(1);
}
console.log("\nAll family-api checks passed");
