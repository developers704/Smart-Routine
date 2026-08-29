/**
 * Linux-side inspection of the Swift plugin. This does not compile Swift and
 * must not be treated as an Xcode build result.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "ios", "App", "App", "Plugins", "RoutineAlarms");

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

const files = {
  plugin: "RoutineAlarmsPlugin.swift",
  service: "AlarmKitService.swift",
  identity: "RoutineAlarmIdentity.swift",
  metadata: "RoutineAlarmMetadata.swift",
  challenge: "WakeChallengeService.swift",
  intent: "VerifyAwakeIntent.swift",
};

const sources = {};
for (const [key, name] of Object.entries(files)) {
  sources[key] = await readFile(path.join(pluginDir, name), "utf8");
  assert(sources[key].length > 0, `${name} exists`);
}

assert(sources.plugin.includes("@objc(RoutineAlarmsPlugin)"), "Capacitor 8 @objc plugin name");
assert(sources.plugin.includes("CAPBridgedPlugin"), "Conforms to CAPBridgedPlugin");
assert(sources.plugin.includes('jsName = "RoutineAlarms"'), "JS name is RoutineAlarms");
for (const method of [
  "isSupported",
  "requestAuthorization",
  "getAuthorizationStatus",
  "syncAlarms",
  "getScheduledAlarms",
  "scheduleTestAlarm",
  "cancelTestAlarm",
  "getPendingWakeChallenge",
  "submitWakeChallenge",
]) {
  assert(sources.plugin.includes(`name: "${method}"`), `Declares ${method}`);
}

assert(sources.plugin.includes('reason": "requires-ios-26"'), "iOS 17-25 reports requires-ios-26");
assert(sources.plugin.includes("Never prompt"), "Authorization is not requested from load()");
const loadBody = sources.plugin.match(/public override func load\(\) \{[\s\S]*?\n    \}/);
assert(Boolean(loadBody), "load() is present");
assert(
  loadBody && !/\.requestAuthorization\s*\(/.test(loadBody[0]),
  "load() does not call requestAuthorization"
);

assert(sources.service.includes("@available(iOS 26.0, *)"), "AlarmKitService is gated to iOS 26");
assert(sources.service.includes("#if canImport(AlarmKit)"), "AlarmKit import is canImport-gated");
assert(sources.plugin.includes('reason": "requires-ios-26"'), "iOS 17-25 reports requires-ios-26");
assert(sources.plugin.includes("if #available(iOS 26.0, *)"), "Plugin support stays on iOS 26.0, not 26.1");
assert(sources.service.includes("if #available(iOS 26.1, *)"), "Alert presentation branches at iOS 26.1");
assert(sources.service.includes("stopButton:"), "iOS 26.0 Alert uses the deprecated stopButton initializer");
assert(
  sources.service.includes("secondaryButton: secondary") && sources.service.includes("secondaryButtonBehavior:"),
  "iOS 26.1+ uses the system-provided Stop initializer"
);
assert(sources.plugin.includes("protectPrimaryId"), "syncAlarms accepts protectPrimaryId");
assert(sources.service.includes("protectFamily"), "AlarmKit sync skips cancelling a protected family");
assert(sources.service.includes("Alarm.Schedule.fixed"), "Uses official fixed-date schedule");
assert(sources.service.includes("Alarm.CountdownDuration"), "Uses official countdown duration");
assert(sources.service.includes(".maximumLimitReached"), "Handles maximumLimitReached");
assert(sources.service.includes("sound: .default"), "Uses the default AlarmKit system sound");
assert(sources.service.includes("secondaryButtonBehavior: useCustomIntent ? .custom : .countdown"), "Snooze vs Solve to Stop");
assert(!sources.service.includes("stopIntent:"), "No stopIntent argument — system Stop must not cancel backups");
assert(sources.intent.includes("LiveActivityIntent"), "Solve to Stop is a LiveActivityIntent");
assert(sources.intent.includes("openAppWhenRun"), "Intent opens the app");
assert(sources.intent.includes("Do not call AlarmManager.stop"), "Opening Solve to Stop does not stop the alarm");
assert(sources.challenge.includes("fnv1a32"), "Math generator matches the JS algorithm");
assert(sources.challenge.includes("Mulberry32"), "Math RNG matches the JS algorithm");
assert(!sources.plugin.includes("expectedAnswer"), "Plugin JS payloads do not mention expectedAnswer");
assert(sources.identity.includes("6dc9a1a0-5e11-4111-9c0d-0000006dc901"), "UUID namespace matches JS");

const widget = await readFile(
  path.join(root, "ios", "App", "RoutineAlarmWidget", "RoutineAlarmLiveActivity.swift"),
  "utf8"
);
assert(widget.includes("import ActivityKit"), "Widget imports ActivityKit");
assert(widget.includes("import WidgetKit"), "Widget imports WidgetKit");
assert(widget.includes("import AlarmKit"), "Widget imports AlarmKit");
assert(widget.includes("import SwiftUI"), "Widget imports SwiftUI");
assert(widget.includes("ActivityConfiguration(for: AlarmAttributes<RoutineAlarmMetadata>.self)"), "Widget uses AlarmAttributes");
assert(widget.includes("dynamicIsland:"), "Dynamic Island is implemented");
assert(widget.includes("compactLeading"), "Compact Dynamic Island");
assert(widget.includes("minimal:"), "Minimal Dynamic Island");
assert(widget.includes("@available(iOS 26.0, *)"), "Widget is iOS 26");
assert(widget.includes("No App Group"), "App Group is documented as unused");

if (failed) {
  console.error(`\n${failed} swift-plugin check(s) failed`);
  process.exit(1);
}
console.log("\nAll swift-plugin checks passed (source inspection only — not an Xcode build)");
