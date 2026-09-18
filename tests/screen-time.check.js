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
const reportPlist = await readFile(path.join(root, "ios", "App", "ScreenTimeReport", "Info.plist"), "utf8");
const pbx = await readFile(path.join(root, "ios", "App", "App.xcodeproj", "project.pbxproj"), "utf8");
const appJs = await readFile(path.join(root, "client", "app.js"), "utf8");
const screenJs = await readFile(path.join(root, "client", "screen-time.js"), "utf8");
const appEnt = await readFile(path.join(root, "ios", "App", "App", "App.entitlements"), "utf8");

assert(plugin.includes("@objc(ScreenTimePlugin)"), "Capacitor plugin name");
assert(plugin.includes('jsName = "ScreenTime"'), "JS name is ScreenTime");
assert(plugin.includes("Never prompt"), "load() documents no auto prompt");
assert(!/override func load\(\)[\s\S]{0,200}requestAuthorization/.test(plugin), "load() does not request Family Controls");
assert(plugin.includes("requestAuthorization(for: .child)"), "Child-device authorization uses .child");
assert(plugin.includes("children-report"), "Parent iPhone uses children-report, not .child on Kash’s device");
assert(plugin.includes("Do not call requestAuthorization(for: .child) here"), "Parent path documents child-device-only authorization");
assert(store.includes(".children"), "Parent DeviceActivityFilter uses children");
assert(plugin.includes("FamilyActivityPicker") || host.includes("FamilyActivityPicker"), "Choose Apps uses FamilyActivityPicker");
assert(host.includes("DeviceActivityReport"), "Host embeds DeviceActivityReport");
assert(report.includes("DeviceActivityReportExtension"), "Report extension is DeviceActivityReportExtension");
assert(reportPlist.includes("EXAppExtensionAttributes"), "Report Info.plist is ExtensionKit");
assert(reportPlist.includes("com.apple.deviceactivityui.report-extension"), "Report extension point is DeviceActivity UI");
assert(!reportPlist.includes("NSExtension"), "Report Info.plist has no NSExtension key");
assert(pbx.includes("com.apple.product-type.extensionkit-extension"), "Xcode product type is ExtensionKit");
assert(pbx.includes("wrapper.extensionkit-extension"), "Report product is an ExtensionKit wrapper");
assert(pbx.includes("Embed ExtensionKit Extensions"), "Report is embedded as ExtensionKit");
assert(pbx.includes("$(EXTENSIONS_FOLDER_PATH)"), "Report copies into the Extensions folder");
assert(report.includes("totalActivityDuration"), "Report reads total duration from Apple");
assert(report.includes("social"), "Report has a social-media metric");
assert(report.includes("numberOfNotifications"), "Notification counts use Apple's numberOfNotifications field");
assert(store.includes("group.app.routine.calendar"), "Selection stays in the App Group");
assert(!plugin.includes("UserDefaults.standard.set(selection"), "Plugin does not stuff tokens into a JS-visible store");
assert(!screenJs.includes("applicationTokens"), "Web bridge never mentions tokens");
assert(!screenJs.includes("totalActivityDuration"), "Web bridge never reads durations");
const familyUi = await readFile(path.join(root, "client", "family-ui.js"), "utf8");
assert(appJs.includes('data-view="activity"'), "Activity tab sits in the nav");
assert(appJs.includes("Enable Activity"), "Enable Activity button exists");
assert(appJs.includes("Choose Apps"), "Choose Apps button exists");
assert(familyUi.includes("Enable Location"), "Anika can enable location from the Map tab");
assert(!familyUi.includes("Sharing with Kash"), "Member UI does not say Sharing with Kash");
assert(familyUi.includes("Activity unavailable"), "Missing activity shows a plain unavailable state");
assert(!familyUi.includes("Family Sharing"), "Main family UI does not say Family Sharing");
assert(!familyUi.includes("pairing"), "Main family UI has no pairing copy");
assert(appJs.includes("navIcon(\"notes\")") && appJs.includes("navIcon(\"set\")"), "Notes and Set use the new nav icons");
assert(appEnt.includes("com.apple.developer.family-controls"), "App entitlements include Family Controls");

if (failed) {
  console.error(`\n${failed} screen-time check(s) failed`);
  process.exit(1);
}
console.log("\nAll screen-time checks passed");
