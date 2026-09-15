/**
 * Screen Time stays native. These checks inspect sources; they are not an
 * Xcode compile, Family Controls signing result, or iPhone run.
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

const plugin = await readFile(
  path.join(root, "ios", "App", "App", "Plugins", "ScreenTime", "ScreenTimePlugin.swift"),
  "utf8"
);
const store = await readFile(
  path.join(root, "ios", "App", "App", "Plugins", "ScreenTime", "ScreenTimeStore.swift"),
  "utf8"
);
const host = await readFile(
  path.join(root, "ios", "App", "App", "Plugins", "ScreenTime", "ScreenTimeHost.swift"),
  "utf8"
);
const report = await readFile(path.join(root, "ios", "App", "ScreenTimeReport", "ScreenTimeReport.swift"), "utf8");
const appJs = await readFile(path.join(root, "client", "app.js"), "utf8");
const screenJs = await readFile(path.join(root, "client", "screen-time.js"), "utf8");
const appEnt = await readFile(path.join(root, "ios", "App", "App", "App.entitlements"), "utf8");

assert(plugin.includes("@objc(ScreenTimePlugin)"), "Capacitor plugin name");
assert(plugin.includes('jsName = "ScreenTime"'), "JS name is ScreenTime");
assert(plugin.includes("Never prompt"), "load() documents no auto prompt");
assert(!/override func load\(\)[\s\S]{0,200}requestAuthorization/.test(plugin), "load() does not request Family Controls");
assert(plugin.includes("requestAuthorization(for: .individual)"), "Anika uses individual Family Controls authorization");
assert(plugin.includes("requestAuthorization(for: .child)"), "Kash uses child/guardian Family Controls authorization");
assert(store.includes(".children"), "Parent DeviceActivityFilter uses children");
assert(store.includes('usersMode() == "children"') || store.includes("usersMode()"), "Reporting users mode is stored natively");
assert(plugin.includes("FamilyActivityPicker") || host.includes("FamilyActivityPicker"), "Choose Apps uses FamilyActivityPicker");
assert(host.includes("DeviceActivityReport"), "Host embeds DeviceActivityReport");
assert(report.includes("DeviceActivityReportExtension"), "Report extension is DeviceActivityReportExtension");
assert(report.includes("totalActivityDuration"), "Report reads total duration from Apple");
assert(report.includes("social"), "Report has a social-media metric");
assert(report.includes("notificationCount"), "Notification counts only when Apple provides them");
assert(store.includes("group.app.routine.calendar"), "Selection stays in the App Group");
assert(!plugin.includes("UserDefaults.standard.set(selection"), "Plugin does not stuff tokens into a JS-visible store");
assert(!screenJs.includes("applicationTokens"), "Web bridge never mentions tokens");
assert(!screenJs.includes("totalActivityDuration"), "Web bridge never reads durations");
const familyUi = await readFile(path.join(root, "client", "family-ui.js"), "utf8");
assert(appJs.includes('data-view="activity"'), "Activity tab sits in the nav");
assert(appJs.includes("Enable App Activity"), "Enable App Activity button exists");
assert(appJs.includes("Choose Apps"), "Choose Apps button exists");
assert(familyUi.includes("Share with Kash"), "Anika has Share with Kash status");
assert(familyUi.includes("Family Sharing setup required"), "Missing guardian auth shows Family Sharing setup");
assert(appJs.includes("navIcon(\"notes\")") && appJs.includes("navIcon(\"set\")"), "Notes and Set use the new nav icons");
assert(appEnt.includes("com.apple.developer.family-controls"), "App entitlements include Family Controls");

if (failed) {
  console.error(`\n${failed} screen-time check(s) failed`);
  process.exit(1);
}
console.log("\nAll screen-time checks passed");
