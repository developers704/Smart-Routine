/**
 * Source checks for Family Tracker iOS wiring. Not an Xcode compile or device run.
 *
 * Do not read ios/App/App/capacitor.config.json — Capacitor generates that
 * file during `npx cap sync ios`, and a clean Git checkout does not contain it.
 * Plugin registration is asserted from committed capacitor.config.json plus
 * scripts/patch-ios.mjs packageClassList logic.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

const loc = await readFile(
  path.join(root, "ios", "App", "App", "Plugins", "FamilyLocation", "FamilyLocationPlugin.swift"),
  "utf8"
);
const plugin = await readFile(
  path.join(root, "ios", "App", "App", "Plugins", "ScreenTime", "ScreenTimePlugin.swift"),
  "utf8"
);
const store = await readFile(
  path.join(root, "ios", "App", "App", "Plugins", "ScreenTime", "ScreenTimeStore.swift"),
  "utf8"
);
const patch = await readFile(path.join(root, "scripts", "patch-ios.mjs"), "utf8");
const plist = await readFile(path.join(root, "ios", "App", "App", "Info.plist"), "utf8");
const capSource = await readFile(path.join(root, "capacitor.config.json"), "utf8");
const push = await readFile(
  path.join(root, "ios", "App", "App", "Plugins", "FamilyPush", "FamilyPushPlugin.swift"),
  "utf8"
);
const appEnt = await readFile(path.join(root, "ios", "App", "App", "App.entitlements"), "utf8");
const familyUi = await readFile(path.join(root, "client", "family-ui.js"), "utf8");
const familyApi = await readFile(path.join(root, "client", "family-api.js"), "utf8");
const locJs = await readFile(path.join(root, "client", "family-location.js"), "utf8");
const server = await readFile(path.join(root, "server", "family.js"), "utf8");
const shared = await readFile(path.join(root, "client", "shared", "family.js"), "utf8");

assert(loc.includes("@objc(FamilyLocationPlugin)"), "FamilyLocation Capacitor plugin");
assert(loc.includes('jsName = "FamilyLocation"'), "JS name is FamilyLocation");
assert(loc.includes("Never prompt"), "load() documents no auto prompt");
assert(!/override func load\(\)[\s\S]{0,240}requestWhenInUseAuthorization/.test(loc), "load() does not request When In Use");
assert(!/override func load\(\)[\s\S]{0,240}requestAlwaysAuthorization/.test(loc), "load() does not request Always");
assert(loc.includes("requestWhenInUseAuthorization"), "When In Use is a dedicated method");
assert(loc.includes("requestAlwaysAuthorization"), "Always is a dedicated method");
assert(loc.includes("when-in-use-first"), "Always requires When In Use first");
assert(loc.includes("showsBackgroundLocationIndicator = true"), "Persistent sharing indicator");
assert(plugin.includes("children-report"), "Kash uses children-report on the parent iPhone");
assert(plugin.includes("Do not call requestAuthorization(for: .child) here"), "Parent does not authorize as child");
assert(push.includes("@objc(FamilyPushPlugin)"), "FamilyPush plugin exists");
assert(push.includes("Never registers from load"), "APNs is not registered from load()");
assert(plist.includes("remote-notification"), "Remote notification background mode");
assert(appEnt.includes("aps-environment"), "App entitlements include Push");
assert(appEnt.includes("group.app.routine.calendar"), "Existing App Group unchanged");
assert(!familyUi.toLowerCase().includes("pairing"), "No pairing UI copy");
assert(!familyApi.includes("profileId"), "Login API does not send a profile id");
assert(!familyApi.includes("passwordHash"), "Client never handles password hashes");
assert(!familyUi.includes("123456"), "Login UI does not embed the test password");
assert(!familyApi.includes("123456"), "Login API client does not embed the test password");
assert(!shared.includes("123456"), "Shared family metadata has no test password");
assert(patch.includes("FamilyPushPlugin"), "patch-ios registers FamilyPushPlugin");
assert(patch.includes("FamilyLocationPlugin"), "patch-ios registers FamilyLocationPlugin");
assert(
  /needed = \[[^\]]*FamilyLocationPlugin[^\]]*FamilyPushPlugin/.test(patch),
  "packageClassList needed plugins include FamilyLocationPlugin"
);
assert(patch.includes("com.apple.developer.family-controls"), "Family Controls entitlement is patched");
assert(plist.includes("NSLocationAlwaysAndWhenInUseUsageDescription"), "Always usage string");
assert(plist.includes("UIBackgroundModes"), "Background location mode declared");
assert(plist.includes("<string>location</string>"), "location background mode");
{
  const capJson = JSON.parse(capSource);
  assert(capJson.appId === "app.routine.calendar", "Committed Capacitor appId is app.routine.calendar");
  assert(
    !Object.prototype.hasOwnProperty.call(capJson, "packageClassList"),
    "Committed capacitor.config.json does not contain generated packageClassList"
  );
}
assert(!locJs.includes("applicationTokens"), "Location JS never mentions Screen Time tokens");
assert(!server.includes("totalActivityDuration"), "Backend never stores Screen Time durations");
assert(!/return "Live"/.test(shared), "Shared freshness helper does not return Live");
assert(locJs.includes("requestAlwaysLocation"), "Always is an explicit JS action");

if (failed) {
  console.error(`\n${failed} ios-family check(s) failed`);
  process.exit(1);
}
console.log("\nAll ios-family checks passed");
