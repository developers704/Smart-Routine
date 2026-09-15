/**
 * Source checks for Family Tracker iOS wiring. Not an Xcode compile or device run.
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
const cap = await readFile(path.join(root, "ios", "App", "App", "capacitor.config.json"), "utf8");
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
assert(plugin.includes("requestAuthorization(for: .child)"), "Guardian/child Screen Time path");
assert(plugin.includes("requestAuthorization(for: .individual)"), "Individual Screen Time path");
assert(store.includes(".children"), "DeviceActivityFilter can target children");
assert(patch.includes("FamilyLocationPlugin"), "patch-ios registers FamilyLocationPlugin");
assert(patch.includes("com.apple.developer.family-controls"), "Family Controls entitlement is patched");
assert(plist.includes("NSLocationAlwaysAndWhenInUseUsageDescription"), "Always usage string");
assert(plist.includes("UIBackgroundModes"), "Background location mode declared");
assert(plist.includes("<string>location</string>"), "location background mode");
assert(cap.includes("FamilyLocationPlugin"), "capacitor.config registers FamilyLocationPlugin");
assert(!locJs.includes("applicationTokens"), "Location JS never mentions Screen Time tokens");
assert(!server.includes("totalActivityDuration"), "Backend never stores Screen Time durations");
assert(!/return "Live"/.test(shared), "Shared freshness helper does not return Live");
assert(locJs.includes("requestAlwaysLocation"), "Always is an explicit JS action");

if (failed) {
  console.error(`\n${failed} ios-family check(s) failed`);
  process.exit(1);
}
console.log("\nAll ios-family checks passed");
