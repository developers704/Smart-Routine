/**
 * Screen Time stays native. These checks inspect sources; they are not an
 * Xcode compile, Family Controls signing result, or iPhone run.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clipReportRect } from "../client/screen-time.js";

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
const styles = await readFile(path.join(root, "client", "styles.css"), "utf8");
const appJs = await readFile(path.join(root, "client", "app.js"), "utf8");
const screenJs = await readFile(path.join(root, "client", "screen-time.js"), "utf8");
const appEnt = await readFile(path.join(root, "ios", "App", "App", "App.entitlements"), "utf8");

assert(plugin.includes("@objc(ScreenTimePlugin)"), "Capacitor plugin name");
assert(plugin.includes('jsName = "ScreenTime"'), "JS name is ScreenTime");
assert(plugin.includes("Never prompt"), "load() documents no auto prompt");
assert(!/override func load\(\)[\s\S]{0,200}requestAuthorization/.test(plugin), "load() does not request Family Controls");
assert(plugin.includes("requestAuthorization(for: .child)"), "Child-device authorization uses .child");
assert(plugin.includes("requestAuthorization(for: .individual)"), "A new or adult Apple ID can authorize this iPhone");
assert(plugin.includes("Task { @MainActor in"), "Family Controls sheet is requested on the main actor");
assert(plugin.includes('payload["fallback"] = "individual"'), "Child failure falls back to this iPhone’s Screen Time");
assert(plugin.includes("children-report"), "Parent iPhone uses children-report, not .child on Kash’s device");
assert(plugin.includes("Do not call requestAuthorization(for: .child) here"), "Parent path documents child-device-only authorization");
assert(store.includes(".children"), "Parent DeviceActivityFilter uses children");
assert(plugin.includes("FamilyActivityPicker") || host.includes("FamilyActivityPicker"), "Choose Apps uses FamilyActivityPicker");
assert(host.includes("DeviceActivityReport"), "Host embeds DeviceActivityReport");
assert(report.includes("DeviceActivityReportExtension"), "Report extension is DeviceActivityReportExtension");
assert(!report.includes("ScrollView"), "Report does not scroll over the page chrome");
assert(!report.includes("Color.white.opacity"), "Report cards are not translucent white");
assert(report.includes("Color(red: 0.173, green: 0.122, blue: 0.157)"), "Report values use the app ink color");
assert(host.includes("clipsToBounds = true"), "Native overlay is clipped to the report slot");
assert(host.includes("isUserInteractionEnabled = false"), "Report drag cannot steal the page or cover the nav");
assert(host.includes("autoresizingMask = []"), "Overlay does not stretch with the web view");
assert(plugin.includes(".convert(raw, to:"), "Overlay frame is converted from the web view");
assert(screenJs.includes("reportHostFrame"), "JS measures the host slot");
assert(screenJs.includes("visualViewport"), "Overlay tracks viewport scroll and resize");
assert(screenJs.includes('querySelector("nav.nav")'), "Overlay is clipped above the nav");
assert(styles.includes("height: 300px"), "Report host has a fixed slot");
assert(/\.activity-report-host \{[\s\S]*?overflow: hidden/.test(styles), "Report host clips overflow");
assert(/\.nav[\s\S]{0,220}background: #fffafc/.test(styles), "Nav is opaque so labels stay readable");
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
assert(appJs.includes("describeActivityEnable"), "Settings keeps the Apple error after Enable Activity");
assert(!appJs.includes('ui.screenTime.error || "Activity was not enabled."'), "Diagnostics does not drop the plugin error");
assert(appJs.includes("Choose Apps"), "Choose Apps button exists");
assert(appJs.includes("notes-page"), "Notes is a dedicated full page");
assert(appJs.includes("Turn into event"), "Saved notes can become events");
assert(appJs.includes("requestAnimationFrame"), "Taps paint before waiting on Activity or location");
assert(appJs.includes("memberDayChrome"), "Day chrome is isolated from other Anika tabs");
assert(appJs.includes('ui.view !== "today"'), "Hero and Build schedule stay on Day");
assert(!appJs.includes("parentOverviewHtml"), "Kash no longer has an Overview page");
assert(!appJs.includes("parentActivityHtml"), "Kash no longer has an Activity page");
assert(appJs.includes("isMember() && ui.view === \"activity\""), "Screen Time overlay attaches only for Anika");
assert(familyUi.includes("Enable Location"), "Anika can enable location from the Map tab");
assert(!familyUi.includes("Sharing with Kash"), "Member UI does not say Sharing with Kash");
assert(!familyUi.includes('data-view="activity"'), "Kash nav has no Activity tab");
assert(!familyUi.includes("Overview"), "Kash nav has no Overview tab");
assert(!familyUi.includes("Family Sharing"), "Main family UI does not say Family Sharing");
assert(!familyUi.includes("pairing"), "Main family UI has no pairing copy");
assert(familyUi.includes("Call Anika"), "Kash map has Call Anika");
assert(familyUi.includes("ANIKA_WHATSAPP.href"), "Call Anika uses the WhatsApp constant");
assert(familyUi.includes("nav-2"), "Kash nav is Map + Settings");
const copyJs = await readFile(path.join(root, "client", "copy.js"), "utf8");
assert(copyJs.includes("wa.me/14087500411"), "Call Anika WhatsApp is +1 408 750-0411");
assert(appJs.includes("navIcon(\"notes\")") && appJs.includes("navIcon(\"set\")"), "Notes and Set use the new nav icons");
assert(appEnt.includes("com.apple.developer.family-controls"), "App entitlements include Family Controls");
{
  const overNav = clipReportRect({ top: 500, bottom: 900, left: 16, right: 390 }, 640, 390, 844);
  assert(overNav.height === 140, `Overlay stops at the nav (got ${overNav.height})`);
  assert(overNav.top === 500, "Visible host top is unchanged when it is on-screen");
  const offscreen = clipReportRect({ top: -80, bottom: 40, left: 16, right: 390 }, 640, 390, 844);
  assert(offscreen.top === 0 && offscreen.height === 40, "Host above the viewport is clipped, not left floating");
  const tiny = clipReportRect({ top: 700, bottom: 890, left: 16, right: 390 }, 680, 390, 844);
  assert(tiny.height === 0, "Host fully under the nav has no overlay height");
}

if (failed) {
  console.error(`\n${failed} screen-time check(s) failed`);
  process.exit(1);
}
console.log("\nAll screen-time checks passed");
