/**
 * scripts/patch-ios.mjs runs after every `npx cap sync ios`, so it has to be
 * idempotent and it must not wander outside the App target.
 *
 * An earlier version walked the whole ios/ tree and injected the app's usage
 * descriptions into every Info.plist it found, including pod framework plists
 * under ios/App/Pods.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "patch-ios.mjs");

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

const infoPlist = path.join(root, "ios", "App", "App", "Info.plist");
const pbxproj = path.join(root, "ios", "App", "App.xcodeproj", "project.pbxproj");
const podfile = path.join(root, "ios", "App", "Podfile");

const original = {
  plist: await readFile(infoPlist, "utf8"),
  pbxproj: await readFile(pbxproj, "utf8"),
  podfile: await readFile(podfile, "utf8"),
};

// --- pod fixtures the script must ignore ---------------------------------
const podsDir = path.join(root, "ios", "App", "Pods", "FakePod");
await mkdir(path.join(podsDir, "Fake.xcodeproj"), { recursive: true });
const podPbxproj = path.join(podsDir, "Fake.xcodeproj", "project.pbxproj");
const podPlist = path.join(podsDir, "Info.plist");
const podPbxprojBody = 'IPHONEOS_DEPLOYMENT_TARGET = 12.0;\nTARGETED_DEVICE_FAMILY = "1,2";\n';
const podPlistBody =
  '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>FakePod</string>\n</dict>\n</plist>\n';
await writeFile(podPbxproj, podPbxprojBody, "utf8");
await writeFile(podPlist, podPlistBody, "utf8");

// --- first run ------------------------------------------------------------
const first = await run(process.execPath, [script], { cwd: root });
assert(first.stdout.includes("interruptionLevel"), "Reports the local-notifications capability check");

const plistAfter = await readFile(infoPlist, "utf8");
assert(plistAfter.includes("<key>NSUserNotificationsUsageDescription</key>"), "Notification usage description is present");
assert(plistAfter.includes("<key>NSLocationWhenInUseUsageDescription</key>"), "Location usage description is present");
assert(plistAfter.includes("<string>Smart Routine</string>"), "Display name is preserved");
assert(
  plistAfter.includes("<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>"),
  "Bundle identifier reference is preserved"
);
assert(plistAfter.includes("UIInterfaceOrientationPortrait"), "Portrait orientation is present");
assert(plistAfter.includes("<key>UIStatusBarStyle</key>"), "Status bar style is present");
assert(!plistAfter.includes("NSAlarmKitUsageDescription"), "No AlarmKit key is added in this phase");
assert(!plistAfter.includes("FamilyControls"), "No Family Controls key is added in this phase");
assert(
  !plistAfter.includes("NSCalendarsUsageDescription"),
  "No calendar usage description is declared — the app does not use EventKit"
);
assert((plistAfter.match(/<key>UISupportedInterfaceOrientations<\/key>/g) || []).length === 1, "Orientation key is not duplicated");
assert((plistAfter.match(/<\/plist>/g) || []).length === 1, "The plist is still a single document");

const pbxprojAfter = await readFile(pbxproj, "utf8");
assert(
  !/IPHONEOS_DEPLOYMENT_TARGET = (?!17\.0;)/.test(pbxprojAfter),
  "Every deployment target is 17.0"
);
assert(
  !/TARGETED_DEVICE_FAMILY = "(?!1";)/.test(pbxprojAfter),
  "Every target is iPhone-only"
);
assert(pbxprojAfter.includes("PRODUCT_BUNDLE_IDENTIFIER = app.routine.calendar;"), "App id is preserved");

const podfileAfter = await readFile(podfile, "utf8");
assert(podfileAfter.includes("platform :ios, '17.0'"), "Podfile keeps the iOS 17.0 platform");
assert(podfileAfter.includes("pod 'Capacitor'"), "Podfile still uses CocoaPods for Capacitor");
assert(podfileAfter.includes("CapacitorLocalNotifications"), "Podfile still lists the notification plugin");

// --- pod tree untouched ---------------------------------------------------
assert((await readFile(podPbxproj, "utf8")) === podPbxprojBody, "A pod project file is left untouched");
assert((await readFile(podPlist, "utf8")) === podPlistBody, "A pod Info.plist is left untouched");

// --- idempotency ----------------------------------------------------------
const plistBeforeSecond = await readFile(infoPlist, "utf8");
const second = await run(process.execPath, [script], { cwd: root });
assert(second.stdout.includes("Nothing to change"), "A second run reports nothing to change");
assert((await readFile(infoPlist, "utf8")) === plistBeforeSecond, "A second run does not modify the plist");
assert(!second.stdout.includes("updated "), "A second run reports no updates");

const third = await run(process.execPath, [script], { cwd: root });
assert((await readFile(infoPlist, "utf8")) === plistBeforeSecond, "A third run is still a no-op");
assert(third.stdout.includes("already"), "Repeat runs report the settings as already correct");

// --- recovers when Capacitor resets the project --------------------------
await writeFile(
  pbxproj,
  original.pbxproj
    .replace(/IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;/g, "IPHONEOS_DEPLOYMENT_TARGET = 15.0;")
    .replace(/TARGETED_DEVICE_FAMILY = "[^"]*";/g, 'TARGETED_DEVICE_FAMILY = "1,2";'),
  "utf8"
);
const recovery = await run(process.execPath, [script], { cwd: root });
assert(recovery.stdout.includes("updated"), "A reset project is patched again");
const recovered = await readFile(pbxproj, "utf8");
assert(recovered.includes("IPHONEOS_DEPLOYMENT_TARGET = 17.0;"), "Deployment target is restored to 17.0");
assert(recovered.includes('TARGETED_DEVICE_FAMILY = "1";'), "iPhone-only is restored");
assert(!recovered.includes("IPHONEOS_DEPLOYMENT_TARGET = 15.0;"), "No 15.0 target is left behind");

// --- restore --------------------------------------------------------------
await writeFile(infoPlist, original.plist, "utf8");
await writeFile(pbxproj, original.pbxproj, "utf8");
await writeFile(podfile, original.podfile, "utf8");
await rm(path.join(root, "ios", "App", "Pods"), { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} patch-ios check(s) failed`);
  process.exit(1);
}
console.log("\nAll patch-ios checks passed");
