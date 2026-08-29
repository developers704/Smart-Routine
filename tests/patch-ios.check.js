/**
 * scripts/patch-ios.mjs runs after every `npx cap sync ios`, so it has to be
 * idempotent and it must not wander outside the App target.
 *
 * An earlier version walked the whole ios/ tree and injected the app's usage
 * descriptions into every Info.plist it found, including pod framework plists
 * under ios/App/Pods.
 *
 * Everything here runs against a throwaway fixture. The real ios/ project is
 * never created, modified or deleted — on a Mac that would destroy the installed
 * CocoaPods.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultProjectRoot, patchIosProject } from "../scripts/patch-ios.mjs";

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

const quiet = { log: () => {}, warn: () => {} };

// --- fingerprint the real project so we can prove we left it alone -------
const realFiles = [
  path.join(root, "ios", "App", "Podfile"),
  path.join(root, "ios", "App", "App.xcodeproj", "project.pbxproj"),
  path.join(root, "ios", "App", "App", "Info.plist"),
];
const realPods = path.join(root, "ios", "App", "Pods");

async function fingerprint() {
  const out = {};
  for (const file of realFiles) {
    out[file] = existsSync(file)
      ? createHash("sha256").update(await readFile(file)).digest("hex")
      : "absent";
  }
  out.podsExists = existsSync(realPods);
  return out;
}

const realBefore = await fingerprint();

// --- fixture ---------------------------------------------------------------
const FIXTURE_PODFILE = `require_relative '../../node_modules/@capacitor/ios/scripts/pods_helpers'

platform :ios, '15.0'
use_frameworks!

def capacitor_pods
  pod 'Capacitor', :path => '../../node_modules/@capacitor/ios'
  pod 'CapacitorLocalNotifications', :path => '../../node_modules/@capacitor/local-notifications'
end

target 'App' do
  capacitor_pods
end
`;

const FIXTURE_PBXPROJ = `// !$*UTF8*$!
{
\tbuildSettings = {
\t\tIPHONEOS_DEPLOYMENT_TARGET = 15.0;
\t\tPRODUCT_BUNDLE_IDENTIFIER = app.routine.calendar;
\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t};
\tbuildSettingsRelease = {
\t\tIPHONEOS_DEPLOYMENT_TARGET = 15.0;
\t\tPRODUCT_BUNDLE_IDENTIFIER = app.routine.calendar;
\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t};
}
`;

const FIXTURE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Smart Routine</string>
\t<key>CFBundleIdentifier</key>
\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
\t<key>LSRequiresIPhoneOS</key>
\t<true/>
\t<key>UIRequiredDeviceCapabilities</key>
\t<array>
\t\t<string>arm64</string>
\t</array>
</dict>
</plist>
`;

const POD_PBXPROJ = 'IPHONEOS_DEPLOYMENT_TARGET = 12.0;\nTARGETED_DEVICE_FAMILY = "1,2";\n';
const POD_PLIST =
  '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>FakePod</string>\n</dict>\n</plist>\n';
const POD_MANIFEST = "PODFILE CHECKSUM: deadbeef\nCOCOAPODS: 1.15.2\n";

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "routine-ios-fixture-"));

try {
  const fx = {
    podfile: path.join(fixtureRoot, "ios", "App", "Podfile"),
    pbxproj: path.join(fixtureRoot, "ios", "App", "App.xcodeproj", "project.pbxproj"),
    plist: path.join(fixtureRoot, "ios", "App", "App", "Info.plist"),
    podPbxproj: path.join(fixtureRoot, "ios", "App", "Pods", "FakePod", "Fake.xcodeproj", "project.pbxproj"),
    podPlist: path.join(fixtureRoot, "ios", "App", "Pods", "FakePod", "Info.plist"),
    podManifest: path.join(fixtureRoot, "ios", "App", "Pods", "Manifest.lock"),
  };

  await mkdir(path.dirname(fx.pbxproj), { recursive: true });
  await mkdir(path.dirname(fx.plist), { recursive: true });
  await mkdir(path.dirname(fx.podPbxproj), { recursive: true });
  await writeFile(fx.podfile, FIXTURE_PODFILE, "utf8");
  await writeFile(fx.pbxproj, FIXTURE_PBXPROJ, "utf8");
  await writeFile(fx.plist, FIXTURE_PLIST, "utf8");
  await writeFile(fx.podPbxproj, POD_PBXPROJ, "utf8");
  await writeFile(fx.podPlist, POD_PLIST, "utf8");
  await writeFile(fx.podManifest, POD_MANIFEST, "utf8");

  // --- default root points at the repository ------------------------------
  assert(defaultProjectRoot() === root, "Without an override the project root is the repository");

  // --- first run against the fixture --------------------------------------
  const first = patchIosProject({ projectRoot: fixtureRoot, ...quiet });
  assert(first.iosMissing === false, "The fixture project is found");
  assert(first.changed.length === 3, `All three app files are patched (got ${first.changed.length})`);
  assert(first.interruptionLevel === true, "local-notifications reports interruptionLevel support");

  const plistAfter = await readFile(fx.plist, "utf8");
  assert(plistAfter.includes("<key>NSUserNotificationsUsageDescription</key>"), "Notification usage description is added");
  assert(plistAfter.includes("<key>NSLocationWhenInUseUsageDescription</key>"), "Location usage description is added");
  assert(plistAfter.includes("<string>Smart Routine</string>"), "Display name is preserved");
  assert(plistAfter.includes("<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>"), "Bundle identifier reference is preserved");
  assert(plistAfter.includes("UIInterfaceOrientationPortrait"), "Portrait orientation is added");
  assert(plistAfter.includes("<key>UIStatusBarStyle</key>"), "Status bar style is added");
  assert(plistAfter.includes("<string>arm64</string>"), "Existing nested array survives");
  assert(plistAfter.includes("<key>NSAlarmKitUsageDescription</key>"), "AlarmKit usage description is added");
  assert(
    plistAfter.includes("Smart Routine uses alarms for wake-up times, hospital shifts, and leave-time reminders."),
    "AlarmKit usage string matches the product copy"
  );
  assert(plistAfter.includes("<key>NSSupportsLiveActivities</key>"), "Live Activities support is declared");
  assert(!plistAfter.includes("family-controls"), "No Family Controls key is added");
  assert(!plistAfter.includes("NSCalendarsUsageDescription"), "No calendar usage description — the app never uses EventKit");
  assert((plistAfter.match(/<\/plist>/g) || []).length === 1, "The plist is still a single document");
  assert(plistAfter.trimEnd().endsWith("</plist>"), "The plist still ends correctly");

  const pbxprojAfter = await readFile(fx.pbxproj, "utf8");
  assert(!/IPHONEOS_DEPLOYMENT_TARGET = (?!17\.0;)/.test(pbxprojAfter), "Every deployment target becomes 17.0");
  assert(!/TARGETED_DEVICE_FAMILY = "(?!1";)/.test(pbxprojAfter), "Every target becomes iPhone-only");
  assert(pbxprojAfter.includes("PRODUCT_BUNDLE_IDENTIFIER = app.routine.calendar;"), "App id is preserved");
  assert((pbxprojAfter.match(/IPHONEOS_DEPLOYMENT_TARGET = 17\.0;/g) || []).length === 2, "Both build configurations are updated");

  const podfileAfter = await readFile(fx.podfile, "utf8");
  assert(podfileAfter.includes("platform :ios, '17.0'"), "Podfile platform is raised to 17.0");
  assert(podfileAfter.includes("pod 'Capacitor'"), "Podfile still uses CocoaPods for Capacitor");
  assert(podfileAfter.includes("CapacitorLocalNotifications"), "Podfile still lists the notification plugin");

  // --- the fixture's pod tree is untouched --------------------------------
  assert((await readFile(fx.podPbxproj, "utf8")) === POD_PBXPROJ, "A pod project file is left untouched");
  assert((await readFile(fx.podPlist, "utf8")) === POD_PLIST, "A pod Info.plist is left untouched");
  assert((await readFile(fx.podManifest, "utf8")) === POD_MANIFEST, "Manifest.lock is left untouched");
  assert(existsSync(path.dirname(fx.podPlist)), "The pod directory still exists");

  // --- idempotency ---------------------------------------------------------
  const snapshot = {
    plist: await readFile(fx.plist, "utf8"),
    pbxproj: await readFile(fx.pbxproj, "utf8"),
    podfile: await readFile(fx.podfile, "utf8"),
  };
  const second = patchIosProject({ projectRoot: fixtureRoot, ...quiet });
  assert(second.changed.length === 0, `A second run changes nothing (got ${second.changed.length})`);
  assert(second.already.length === 3, "A second run reports all three files as already correct");
  assert((await readFile(fx.plist, "utf8")) === snapshot.plist, "A second run does not modify the plist");
  assert((await readFile(fx.pbxproj, "utf8")) === snapshot.pbxproj, "A second run does not modify the pbxproj");
  assert((await readFile(fx.podfile, "utf8")) === snapshot.podfile, "A second run does not modify the Podfile");

  const third = patchIosProject({ projectRoot: fixtureRoot, ...quiet });
  assert(third.changed.length === 0, "A third run is still a no-op");

  // --- recovery after Capacitor resets the project -----------------------
  await writeFile(fx.pbxproj, FIXTURE_PBXPROJ, "utf8");
  await writeFile(fx.podfile, FIXTURE_PODFILE, "utf8");
  const recovery = patchIosProject({ projectRoot: fixtureRoot, ...quiet });
  assert(recovery.changed.length === 2, `A reset project is patched again (got ${recovery.changed.length})`);
  const recovered = await readFile(fx.pbxproj, "utf8");
  assert(recovered.includes("IPHONEOS_DEPLOYMENT_TARGET = 17.0;"), "Deployment target is restored to 17.0");
  assert(recovered.includes('TARGETED_DEVICE_FAMILY = "1";'), "iPhone-only is restored");
  assert(!recovered.includes("IPHONEOS_DEPLOYMENT_TARGET = 15.0;"), "No 15.0 target is left behind");
  assert((await readFile(fx.plist, "utf8")) === snapshot.plist, "An already-correct plist is not rewritten during recovery");

  // --- a missing ios/ folder is reported, not an error --------------------
  const emptyRoot = await mkdtemp(path.join(tmpdir(), "routine-ios-empty-"));
  try {
    const missing = patchIosProject({ projectRoot: emptyRoot, ...quiet });
    assert(missing.iosMissing === true, "A project without ios/ is reported as missing");
    assert(missing.changed.length === 0, "Nothing is written when ios/ is absent");
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }

  // --- the CLI honours the environment override --------------------------
  await writeFile(fx.pbxproj, FIXTURE_PBXPROJ, "utf8");
  const cli = await run(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, SMART_ROUTINE_PROJECT_ROOT: fixtureRoot },
  });
  assert(cli.stdout.includes("updated"), "The CLI patches the project named by SMART_ROUTINE_PROJECT_ROOT");
  assert(
    (await readFile(fx.pbxproj, "utf8")).includes("IPHONEOS_DEPLOYMENT_TARGET = 17.0;"),
    "The CLI wrote to the fixture"
  );
  const cliAgain = await run(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, SMART_ROUTINE_PROJECT_ROOT: fixtureRoot },
  });
  assert(cliAgain.stdout.includes("Nothing to change"), "The CLI is idempotent too");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

// --- full App pbxproj fixture (widget + plugin injection) -----------------
const fullRoot = await mkdtemp(path.join(tmpdir(), "routine-ios-full-"));
try {
  const realPbx = path.join(root, "ios", "App", "App.xcodeproj", "project.pbxproj");
  const realPlist = path.join(root, "ios", "App", "App", "Info.plist");
  const realPodfile = path.join(root, "ios", "App", "Podfile");
  const fxPbx = path.join(fullRoot, "ios", "App", "App.xcodeproj", "project.pbxproj");
  const fxPlist = path.join(fullRoot, "ios", "App", "App", "Info.plist");
  const fxPod = path.join(fullRoot, "ios", "App", "Podfile");
  const fxCap = path.join(fullRoot, "ios", "App", "App", "capacitor.config.json");
  await mkdir(path.dirname(fxPbx), { recursive: true });
  await mkdir(path.dirname(fxPlist), { recursive: true });
  await writeFile(fxPbx, await readFile(realPbx, "utf8"), "utf8");
  await writeFile(fxPlist, await readFile(realPlist, "utf8"), "utf8");
  await writeFile(fxPod, await readFile(realPodfile, "utf8"), "utf8");
  await writeFile(
    fxCap,
    JSON.stringify({ appId: "app.routine.calendar", packageClassList: ["AppPlugin"] }, null, "\t"),
    "utf8"
  );

  const firstFull = patchIosProject({ projectRoot: fullRoot, ...quiet });
  const pbx = await readFile(fxPbx, "utf8");
  assert(pbx.includes("RoutineAlarmsPlugin.swift in Sources"), "Plugin sources are added to the App target");
  assert(pbx.includes("name = RoutineAlarmWidget;"), "Widget target is created");
  assert(pbx.includes("Embed Foundation Extensions"), "Widget is embedded in the App");
  assert(pbx.includes("PRODUCT_BUNDLE_IDENTIFIER = app.routine.calendar.RoutineAlarmWidget;"), "Widget bundle id is set");
  assert(pbx.includes("IPHONEOS_DEPLOYMENT_TARGET = 26.0;"), "Widget deploys at iOS 26.0");
  assert(
    (pbx.match(/IPHONEOS_DEPLOYMENT_TARGET = 17\.0;/g) || []).length >= 2,
    "The App target remains iOS 17.0"
  );
  assert(pbx.includes("-weak_framework AlarmKit"), "AlarmKit is weak-linked on the App target");
  const cap = JSON.parse(await readFile(fxCap, "utf8"));
  assert(cap.packageClassList.includes("RoutineAlarmsPlugin"), "packageClassList registers the local plugin");
  const plist = await readFile(fxPlist, "utf8");
  assert(plist.includes("NSAlarmKitUsageDescription"), "Full fixture gets the AlarmKit usage string");
  assert(plist.includes("NSSupportsLiveActivities"), "Full fixture enables Live Activities");
  assert(!plist.includes("family-controls"), "Full fixture still has no Family Controls");

  const snapshot = await readFile(fxPbx, "utf8");
  const secondFull = patchIosProject({ projectRoot: fullRoot, ...quiet });
  assert(secondFull.changed.length === 0, `Full-project second run is a no-op (got ${secondFull.changed.length}: ${secondFull.changed.join("; ")})`);
  assert((await readFile(fxPbx, "utf8")) === snapshot, "Widget injection is idempotent");
  assert(firstFull.changed.length > 0, "First full-project run reports changes");
} finally {
  await rm(fullRoot, { recursive: true, force: true });
}

// --- the real project must be exactly as we found it ---------------------
const realAfter = await fingerprint();
for (const file of realFiles) {
  assert(
    realAfter[file] === realBefore[file],
    `${path.relative(root, file)} is byte-for-byte unchanged`
  );
}
assert(realAfter.podsExists === realBefore.podsExists, "The real ios/App/Pods directory is left as it was");
assert(!existsSync(path.join(realPods, "FakePod")), "No fixture was written into the real pod tree");
assert(!existsSync(fixtureRoot), "The temporary fixture is cleaned up");

if (failed) {
  console.error(`\n${failed} patch-ios check(s) failed`);
  process.exit(1);
}
console.log("\nAll patch-ios checks passed");
