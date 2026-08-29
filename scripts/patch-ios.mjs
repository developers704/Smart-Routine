/**
 * Applies Smart Routine's iOS project settings after `npx cap sync ios`.
 *
 * Capacitor regenerates parts of the iOS project, so these settings are
 * re-asserted here rather than hand-edited in Xcode:
 *
 *   - minimum iOS 17.0 (above Capacitor 8's floor of 15.0)
 *   - iPhone only, portrait only
 *   - notification, location and calendar usage descriptions
 *
 * Idempotent: running it twice changes nothing and reports "already correct".
 * Scoped to the App target — it must never rewrite files under ios/App/Pods,
 * where an earlier version of this script was injecting the app's usage
 * descriptions into pod framework Info.plists.
 *
 * AlarmKit and Family Controls keys are deliberately absent; they belong to a
 * later phase.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IOS_DEPLOYMENT_TARGET = "17.0";
const DEVICE_FAMILY_IPHONE = "1";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ios = path.join(root, "ios");

const targets = {
  podfile: path.join(ios, "App", "Podfile"),
  pbxproj: path.join(ios, "App", "App.xcodeproj", "project.pbxproj"),
  infoPlist: path.join(ios, "App", "App", "Info.plist"),
};

const PLIST_STRINGS = {
  NSLocationWhenInUseUsageDescription:
    "Smart Routine uses your location as the start point for walking and driving times.",
  NSUserNotificationsUsageDescription:
    "Smart Routine uses notifications for shift, study, meal, and notepad alarms.",
};

const PLIST_BOOLS = {
  ITSAppUsesNonExemptEncryption: false,
  UIViewControllerBasedStatusBarAppearance: true,
};

const PLIST_RAW = {
  UIStatusBarStyle: "<string>UIStatusBarStyleDarkContent</string>",
  UISupportedInterfaceOrientations:
    "<array>\n\t\t<string>UIInterfaceOrientationPortrait</string>\n\t</array>",
};

const changes = [];
const skipped = [];

function report(file, what, changed) {
  const label = `${path.relative(root, file)}: ${what}`;
  if (changed) changes.push(label);
  else skipped.push(label);
}

function patchPodfile(file) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, "utf8");
  let after = before;
  if (/platform :ios, ['"][\d.]+['"]/.test(after)) {
    after = after.replace(/platform :ios, ['"][\d.]+['"]/, `platform :ios, '${IOS_DEPLOYMENT_TARGET}'`);
  } else {
    after = `platform :ios, '${IOS_DEPLOYMENT_TARGET}'\n${after}`;
  }
  if (after !== before) fs.writeFileSync(file, after);
  report(file, `platform :ios ${IOS_DEPLOYMENT_TARGET}`, after !== before);
}

function patchPbxproj(file) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, "utf8");
  let after = before
    .replace(/IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_DEPLOYMENT_TARGET};`)
    .replace(/TARGETED_DEVICE_FAMILY = "[^"]*";/g, `TARGETED_DEVICE_FAMILY = "${DEVICE_FAMILY_IPHONE}";`);
  if (after !== before) fs.writeFileSync(file, after);
  report(file, `deployment target ${IOS_DEPLOYMENT_TARGET}, iPhone-only`, after !== before);
}

/** Inserts before the final </dict> so nested dicts and arrays are untouched. */
function insertPlistEntry(text, key, valueXml) {
  if (text.includes(`<key>${key}</key>`)) return text;
  const close = text.lastIndexOf("</dict>");
  if (close === -1) throw new Error("Info.plist has no closing </dict>");
  const entry = `\t<key>${key}</key>\n\t${valueXml}\n`;
  return text.slice(0, close) + entry + text.slice(close);
}

function patchInfoPlist(file) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, "utf8");
  let after = before;
  for (const [key, value] of Object.entries(PLIST_STRINGS)) {
    after = insertPlistEntry(after, key, `<string>${value}</string>`);
  }
  for (const [key, value] of Object.entries(PLIST_BOOLS)) {
    after = insertPlistEntry(after, key, value ? "<true/>" : "<false/>");
  }
  for (const [key, value] of Object.entries(PLIST_RAW)) {
    after = insertPlistEntry(after, key, value);
  }
  if (after !== before) fs.writeFileSync(file, after);
  report(file, "usage descriptions, status bar style, portrait orientation", after !== before);
}

/**
 * Capacitor 8's local-notifications plugin accepts interruptionLevel per
 * notification, so the old manual source patch is gone. Verify rather than edit.
 */
function checkLocalNotifications() {
  const pluginSwift = path.join(
    root,
    "node_modules/@capacitor/local-notifications/ios/Sources/LocalNotificationsPlugin/LocalNotificationsPlugin.swift"
  );
  if (!fs.existsSync(pluginSwift)) {
    console.warn("! @capacitor/local-notifications iOS sources not found — run npm ci first.");
    return;
  }
  const text = fs.readFileSync(pluginSwift, "utf8");
  if (text.includes("interruptionLevel")) {
    console.log("✓ local-notifications supports interruptionLevel natively (no source patch needed)");
  } else {
    console.warn("! Installed @capacitor/local-notifications does not accept interruptionLevel.");
  }
}

if (!fs.existsSync(ios)) {
  console.log("No ios/ folder yet — run npx cap add ios on a Mac with the Capacitor CLI.");
  process.exit(0);
}

patchPodfile(targets.podfile);
patchPbxproj(targets.pbxproj);
patchInfoPlist(targets.infoPlist);
checkLocalNotifications();

for (const line of changes) console.log(`updated  ${line}`);
for (const line of skipped) console.log(`already  ${line}`);
console.log(
  changes.length
    ? `\nPatched ${changes.length} file(s). Open ios/App/App.xcworkspace in Xcode 26 to build.`
    : "\nNothing to change — the iOS project already matches Smart Routine's settings."
);
