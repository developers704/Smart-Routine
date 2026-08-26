import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ios = path.join(root, "ios");
if (!fs.existsSync(ios)) {
  console.log("No ios/ folder yet — run npx cap add ios on a machine with the Capacitor CLI.");
  process.exit(0);
}

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const files = walk(ios);
for (const file of files) {
  const base = path.basename(file);
  if (base === "Podfile") {
    let t = fs.readFileSync(file, "utf8");
    t = t.replace(/platform :ios, ['"][\d.]+['"]/, "platform :ios, '17.0'");
    if (!t.includes("platform :ios")) t = "platform :ios, '17.0'\n" + t;
    fs.writeFileSync(file, t);
    console.log("patched", file);
  }
  if (base.endsWith(".pbxproj")) {
    let t = fs.readFileSync(file, "utf8");
    t = t.replace(/IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;/g, "IPHONEOS_DEPLOYMENT_TARGET = 17.0;");
    t = t.replace(/TARGETED_DEVICE_FAMILY = "[^"]+";/g, 'TARGETED_DEVICE_FAMILY = "1";');
    fs.writeFileSync(file, t);
    console.log("patched", file);
  }
  if (base === "Info.plist") {
    let t = fs.readFileSync(file, "utf8");
    const inserts = [
      ["NSLocationWhenInUseUsageDescription", "Smart Routine uses your location as the start point for walking and driving times."],
      ["NSUserNotificationsUsageDescription", "Routine uses notifications for shift, study, meal, and notepad alarms so you stay on schedule."],
      ["NSCalendarsUsageDescription", "Routine only stores your hospital schedule on this device."],
      ["ITSAppUsesNonExemptEncryption", false],
    ];
    for (const [key, val] of inserts) {
      if (t.includes(`<key>${key}</key>`)) continue;
      const xml =
        typeof val === "boolean"
          ? `  <key>${key}</key>\n  <${val ? "true" : "false"}/>\n`
          : `  <key>${key}</key>\n  <string>${val}</string>\n`;
      t = t.replace("</dict>", xml + "</dict>");
    }
    if (!t.includes("UIStatusBarStyle")) {
      t = t.replace(
        "</dict>",
        `  <key>UIStatusBarStyle</key>\n  <string>UIStatusBarStyleDarkContent</string>\n  <key>UIViewControllerBasedStatusBarAppearance</key>\n  <true/>\n  <key>UISupportedInterfaceOrientations</key>\n  <array>\n    <string>UIInterfaceOrientationPortrait</string>\n  </array>\n  <key>UISupportedInterfaceOrientations~ipad</key>\n  <array>\n    <string>UIInterfaceOrientationPortrait</string>\n  </array>\n</dict>`
      );
    }
    fs.writeFileSync(file, t);
    console.log("patched", file);
  }
}

const pluginSwift = path.join(
  root,
  "node_modules/@capacitor/local-notifications/ios/Sources/LocalNotificationsPlugin/LocalNotificationsPlugin.swift"
);
if (fs.existsSync(pluginSwift)) {
  const t = fs.readFileSync(pluginSwift, "utf8");
  if (!t.includes("interruptionLevel = .timeSensitive")) {
    console.warn("LocalNotificationsPlugin.swift missing time-sensitive sound patch — re-apply after npm install.");
  } else {
    console.log("iOS notification plugin already patched for sound + calendar time");
  }
}
