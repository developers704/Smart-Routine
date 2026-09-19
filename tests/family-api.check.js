import { FAMILY_API_NATIVE_ORIGIN, familyApiOrigin, familyToken, setFamilyToken, hydrateFamilyToken, FAMILY_TOKEN_STORAGE_KEY } from "../client/family-api.js";

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

const store = Object.create(null);
globalThis.localStorage = {
  getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
  setItem: (key, value) => {
    store[key] = String(value);
  },
  removeItem: (key) => {
    delete store[key];
  },
};

setFamilyToken("tok_live");
assert(familyToken() === "tok_live", "Sign-in stores the bearer token in memory");
assert(store[FAMILY_TOKEN_STORAGE_KEY] === "tok_live", "Sign-in persists the bearer token");
setFamilyToken("");
assert(familyToken() === "", "Sign-out clears the in-memory token");
assert(!Object.prototype.hasOwnProperty.call(store, FAMILY_TOKEN_STORAGE_KEY), "Sign-out removes the persisted token");
store[FAMILY_TOKEN_STORAGE_KEY] = "tok_restored";
assert(hydrateFamilyToken() === "tok_restored", "Cold start hydrates the native session from storage");
assert(familyToken() === "tok_restored", "Hydrated token is used for Authorization");
setFamilyToken("");

if (failed) {
  console.error(`\n${failed} family-api check(s) failed`);
  process.exit(1);
}
console.log("\nAll family-api checks passed");
