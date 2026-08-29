/**
 * Applies Smart Routine's iOS project settings after `npx cap sync ios`.
 *
 * Capacitor regenerates parts of the iOS project, so these settings are
 * re-asserted here rather than hand-edited in Xcode:
 *
 *   - minimum iOS 17.0 (above Capacitor 8's floor of 15.0)
 *   - iPhone only, portrait only
 *   - notification and location usage descriptions
 *
 * Idempotent: running it twice changes nothing and reports "already correct".
 * Scoped to the App target — it must never rewrite files under ios/App/Pods,
 * where an earlier version of this script was injecting the app's usage
 * descriptions into pod framework Info.plists.
 *
 * The project root is injectable (`projectRoot` argument or
 * SMART_ROUTINE_PROJECT_ROOT) so tests can run against a throwaway fixture
 * instead of the real ios/ directory. The CLI defaults to the repository root.
 *
 * AlarmKit and Family Controls keys are deliberately absent; they belong to a
 * later phase.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IOS_DEPLOYMENT_TARGET = "17.0";
const DEVICE_FAMILY_IPHONE = "1";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function defaultProjectRoot() {
  return process.env.SMART_ROUTINE_PROJECT_ROOT
    ? path.resolve(process.env.SMART_ROUTINE_PROJECT_ROOT)
    : repoRoot;
}

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

function targetsFor(projectRoot) {
  const ios = path.join(projectRoot, "ios");
  return {
    ios,
    podfile: path.join(ios, "App", "Podfile"),
    pbxproj: path.join(ios, "App", "App.xcodeproj", "project.pbxproj"),
    infoPlist: path.join(ios, "App", "App", "Info.plist"),
  };
}

function patchPodfile(file, result, rel) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, "utf8");
  let after = before;
  if (/platform :ios, ['"][\d.]+['"]/.test(after)) {
    after = after.replace(/platform :ios, ['"][\d.]+['"]/, `platform :ios, '${IOS_DEPLOYMENT_TARGET}'`);
  } else {
    after = `platform :ios, '${IOS_DEPLOYMENT_TARGET}'\n${after}`;
  }
  if (after !== before) fs.writeFileSync(file, after);
  result.record(`${rel(file)}: platform :ios ${IOS_DEPLOYMENT_TARGET}`, after !== before);
}

function patchPbxproj(file, result, rel) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, "utf8");
  const after = before
    .replace(/IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_DEPLOYMENT_TARGET};`)
    .replace(/TARGETED_DEVICE_FAMILY = "[^"]*";/g, `TARGETED_DEVICE_FAMILY = "${DEVICE_FAMILY_IPHONE}";`);
  if (after !== before) fs.writeFileSync(file, after);
  result.record(`${rel(file)}: deployment target ${IOS_DEPLOYMENT_TARGET}, iPhone-only`, after !== before);
}

/** Inserts before the final </dict> so nested dicts and arrays are untouched. */
function insertPlistEntry(text, key, valueXml) {
  if (text.includes(`<key>${key}</key>`)) return text;
  const close = text.lastIndexOf("</dict>");
  if (close === -1) throw new Error("Info.plist has no closing </dict>");
  return `${text.slice(0, close)}\t<key>${key}</key>\n\t${valueXml}\n${text.slice(close)}`;
}

function patchInfoPlist(file, result, rel) {
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
  result.record(`${rel(file)}: usage descriptions, status bar style, portrait orientation`, after !== before);
}

/**
 * Capacitor 8's local-notifications plugin accepts interruptionLevel per
 * notification, so the old manual source patch is gone. Verify rather than edit.
 * Reads from the package root, where node_modules lives.
 */
function checkLocalNotifications(warn, log) {
  const pluginSwift = path.join(
    repoRoot,
    "node_modules/@capacitor/local-notifications/ios/Sources/LocalNotificationsPlugin/LocalNotificationsPlugin.swift"
  );
  if (!fs.existsSync(pluginSwift)) {
    warn("! @capacitor/local-notifications iOS sources not found — run npm ci first.");
    return false;
  }
  if (fs.readFileSync(pluginSwift, "utf8").includes("interruptionLevel")) {
    log("✓ local-notifications supports interruptionLevel natively (no source patch needed)");
    return true;
  }
  warn("! Installed @capacitor/local-notifications does not accept interruptionLevel.");
  return false;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.projectRoot] folder containing ios/ — defaults to the repo
 */
export function patchIosProject(opts = {}) {
  const projectRoot = opts.projectRoot ? path.resolve(opts.projectRoot) : defaultProjectRoot();
  const log = opts.log || console.log;
  const warn = opts.warn || console.warn;
  const targets = targetsFor(projectRoot);
  const rel = (file) => path.relative(projectRoot, file);

  if (!fs.existsSync(targets.ios)) {
    log("No ios/ folder yet — run npx cap add ios on a Mac with the Capacitor CLI.");
    return { projectRoot, iosMissing: true, changed: [], already: [] };
  }

  const result = {
    projectRoot,
    iosMissing: false,
    changed: [],
    already: [],
    record(label, didChange) {
      (didChange ? this.changed : this.already).push(label);
    },
  };

  patchPodfile(targets.podfile, result, rel);
  patchPbxproj(targets.pbxproj, result, rel);
  patchInfoPlist(targets.infoPlist, result, rel);
  result.interruptionLevel = checkLocalNotifications(warn, log);

  for (const line of result.changed) log(`updated  ${line}`);
  for (const line of result.already) log(`already  ${line}`);
  log(
    result.changed.length
      ? `\nPatched ${result.changed.length} file(s). Open ios/App/App.xcworkspace in Xcode 26 to build.`
      : "\nNothing to change — the iOS project already matches Smart Routine's settings."
  );
  return result;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) patchIosProject();
