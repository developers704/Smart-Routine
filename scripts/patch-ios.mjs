/**
 * Applies Smart Routine's iOS project settings after `npx cap sync ios`.
 *
 * Capacitor regenerates parts of the iOS project, so these settings are
 * re-asserted here rather than hand-edited in Xcode:
 *
 *   - minimum iOS 17.0 for the App target (above Capacitor 8's floor of 15.0)
 *   - iPhone only, portrait only
 *   - notification, location and AlarmKit usage descriptions
 *   - NSSupportsLiveActivities
 *   - local RoutineAlarms + ScreenTime + FamilyLocation plugin sources + packageClassList
 *   - RoutineAlarmWidget (iOS 26.0) for AlarmKit Live Activities
 *   - ScreenTimeReport DeviceActivityReport extension (iOS 26.0)
 *   - Family Controls + App Group entitlements (no Team ID hardcoded)
 *
 * Idempotent: running it twice changes nothing and reports "already correct".
 * Scoped to the App / widget targets — it must never rewrite files under
 * ios/App/Pods.
 *
 * The project root is injectable (`projectRoot` argument or
 * SMART_ROUTINE_PROJECT_ROOT) so tests can run against a throwaway fixture
 * instead of the real ios/ directory. The CLI defaults to the repository root.
 *
 * AlarmKit still uses no App Group. Screen Time uses group.app.routine.calendar
 * so the report extension can read FamilyActivitySelection. Tokens never leave
 * native storage. DEVELOPMENT_TEAM is copied from the App target when present
 * and is never hardcoded.
 */
import { createHash } from "node:crypto";
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
    "Smart Routine uses your location as the start point for walking and driving times, and — if you choose — to share a last-known place with a linked parent.",
  NSLocationAlwaysAndWhenInUseUsageDescription:
    "Always location lets Anika keep sharing her last-known place with Kash in the background for Home alerts. It is requested only after you tap Allow Always, and sharing can be paused or stopped at any time.",
  NSUserNotificationsUsageDescription:
    "Smart Routine uses notifications for shift, study, meal, and notepad alarms.",
  NSAlarmKitUsageDescription:
    "Smart Routine uses alarms for wake-up times, hospital shifts, and leave-time reminders.",
};

const PLIST_BOOLS = {
  ITSAppUsesNonExemptEncryption: false,
  UIViewControllerBasedStatusBarAppearance: true,
  NSSupportsLiveActivities: true,
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
    capConfig: path.join(ios, "App", "App", "capacitor.config.json"),
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
  let after = before
    .replace(/IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_DEPLOYMENT_TARGET};`)
    .replace(/TARGETED_DEVICE_FAMILY = "[^"]*";/g, `TARGETED_DEVICE_FAMILY = "${DEVICE_FAMILY_IPHONE}";`);
  after = restoreWidgetDeployment(after);
  after = restoreScreenTimeDeployment(after);
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
  after = ensureBackgroundModes(after);
  if (after !== before) fs.writeFileSync(file, after);
  result.record(`${rel(file)}: usage descriptions, status bar style, portrait orientation`, after !== before);
}

function ensureBackgroundModes(text) {
  if (!text.includes("<key>UIBackgroundModes</key>")) {
    return insertPlistEntry(
      text,
      "UIBackgroundModes",
      "<array>\n\t\t<string>location</string>\n\t\t<string>remote-notification</string>\n\t</array>"
    );
  }
  if (!text.includes("<string>remote-notification</string>")) {
    return text.replace(
      /<key>UIBackgroundModes<\/key>\s*<array>/,
      "<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>remote-notification</string>"
    );
  }
  return text;
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

export function pbxId(name) {
  return createHash("md5").update(`smart-routine-alarmkit:${name}`).digest("hex").slice(0, 24).toUpperCase();
}

/** Capacitor's stable App-project identifiers. Never match these globally. */
export const CAPACITOR_PBX = {
  APP_TARGET: "504EC3031FED79650016851F",
  APP_SOURCES: "504EC3001FED79650016851F",
  PRODUCTS: "504EC3051FED79650016851F",
  ROOT_GROUP: "504EC2FB1FED79650016851F",
  PROJECT: "504EC2FC1FED79650016851F",
};

export const PLUGIN_SOURCES = [
  "App/Plugins/RoutineAlarms/RoutineAlarmsPlugin.swift",
  "App/Plugins/RoutineAlarms/AlarmKitService.swift",
  "App/Plugins/RoutineAlarms/RoutineAlarmIdentity.swift",
  "App/Plugins/RoutineAlarms/RoutineAlarmMetadata.swift",
  "App/Plugins/RoutineAlarms/WakeChallengeService.swift",
  "App/Plugins/RoutineAlarms/VerifyAwakeIntent.swift",
];

export const PLUGIN_SOURCE_NAMES = PLUGIN_SOURCES.map((relPath) => path.posix.basename(relPath));

export const SCREEN_TIME_PLUGIN_SOURCES = [
  "App/Plugins/ScreenTime/ScreenTimePlugin.swift",
  "App/Plugins/ScreenTime/ScreenTimeStore.swift",
  "App/Plugins/ScreenTime/ScreenTimeHost.swift",
];

export const SCREEN_TIME_PLUGIN_SOURCE_NAMES = SCREEN_TIME_PLUGIN_SOURCES.map((relPath) =>
  path.posix.basename(relPath)
);

export const FAMILY_LOCATION_PLUGIN_SOURCES = [
  "App/Plugins/FamilyLocation/FamilyLocationPlugin.swift",
];

export const FAMILY_LOCATION_PLUGIN_SOURCE_NAMES = FAMILY_LOCATION_PLUGIN_SOURCES.map((relPath) =>
  path.posix.basename(relPath)
);

export const FAMILY_PUSH_PLUGIN_SOURCES = ["App/Plugins/FamilyPush/FamilyPushPlugin.swift"];

export const FAMILY_PUSH_PLUGIN_SOURCE_NAMES = FAMILY_PUSH_PLUGIN_SOURCES.map((relPath) =>
  path.posix.basename(relPath)
);

export const FAMILY_CONTROLS_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.developer.family-controls</key>
	<true/>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>group.app.routine.calendar</string>
	</array>
</dict>
</plist>
`;

export const APP_PUSH_FAMILY_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.developer.family-controls</key>
	<true/>
	<key>aps-environment</key>
	<string>development</string>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>group.app.routine.calendar</string>
	</array>
</dict>
</plist>
`;

export function screenTimePbxId(name) {
  return createHash("md5").update(`smart-routine-screentime:${name}`).digest("hex").slice(0, 24).toUpperCase();
}

export function widgetPbxIds() {
  return {
    product: pbxId("widget-product"),
    target: pbxId("widget-target"),
    sources: pbxId("widget-sources"),
    frameworks: pbxId("widget-frameworks"),
    resources: pbxId("widget-resources"),
    configList: pbxId("widget-config-list"),
    debug: pbxId("widget-debug"),
    release: pbxId("widget-release"),
    embed: pbxId("widget-embed"),
    embedBuild: pbxId("widget-embed-build"),
    proxy: pbxId("widget-proxy"),
    dep: pbxId("widget-dep"),
    swift: pbxId("widget-swift"),
    swiftBuild: pbxId("widget-swift-build"),
    metaBuild: pbxId("widget-meta-build"),
    info: pbxId("widget-info"),
    group: pbxId("widget-group"),
  };
}

function insertSectionLine(text, section, line) {
  let out = text;
  if (!out.includes(`/* Begin ${section} section */`)) {
    const anchor = "/* Begin PBXNativeTarget section */";
    const block = `/* Begin ${section} section */\n\n/* End ${section} section */\n\n`;
    if (out.includes(anchor)) out = out.replace(anchor, `${block}${anchor}`);
    else return text;
  }
  if (out.includes(line.trim())) return out;
  const end = `/* End ${section} section */`;
  const i = out.indexOf(end);
  if (i === -1) return out;
  return `${out.slice(0, i)}${line}\n${out.slice(i)}`;
}

/**
 * Brace-matched object body for a 24-char pbx id. Looks only at that object,
 * never the rest of the file. Global whole-file includes() of an id comment
 * is how the previous patch skipped App Sources / targets / Products wiring
 * after the declarations had already been inserted.
 */
export function objectBody(pbx, id) {
  // Object declarations are exactly two tabs. List references use three or four,
  // so a bare indexOf(`\t\t${id}`) would hit App.buildPhases first and then
  // brace-match the wrong object.
  const commentDecl = `\n\t\t${id} /*`;
  const bareDecl = `\n\t\t${id} = {`;
  let start = pbx.indexOf(commentDecl);
  if (start >= 0) start += 1;
  else {
    start = pbx.indexOf(bareDecl);
    if (start >= 0) start += 1;
  }
  if (start < 0) return null;
  const brace = pbx.indexOf("{", start);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < pbx.length; i++) {
    if (pbx[i] === "{") depth++;
    else if (pbx[i] === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1, text: pbx.slice(start, i + 1) };
    }
  }
  return null;
}

export function extractParenList(objectText, listKey) {
  const needle = `${listKey} = (`;
  const idx = objectText.indexOf(needle);
  if (idx < 0) return null;
  const open = objectText.indexOf("(", idx);
  let depth = 0;
  for (let i = open; i < objectText.length; i++) {
    if (objectText[i] === "(") depth++;
    else if (objectText[i] === ")") {
      depth--;
      if (depth === 0) return objectText.slice(open + 1, i);
    }
  }
  return null;
}

export function listEntries(pbx, objectId, listKey) {
  const obj = objectBody(pbx, objectId);
  if (!obj) return [];
  const list = extractParenList(obj.text, listKey);
  if (list == null) return [];
  return [...list.matchAll(/([A-F0-9]{24}) \/\* ([^*]+) \*\//g)].map((m) => ({
    id: m[1],
    comment: m[2].trim(),
  }));
}

export function parseAppWiring(pbx) {
  return {
    appSources: listEntries(pbx, CAPACITOR_PBX.APP_SOURCES, "files"),
    projectTargets: listEntries(pbx, CAPACITOR_PBX.PROJECT, "targets"),
    appBuildPhases: listEntries(pbx, CAPACITOR_PBX.APP_TARGET, "buildPhases"),
    appDependencies: listEntries(pbx, CAPACITOR_PBX.APP_TARGET, "dependencies"),
    products: listEntries(pbx, CAPACITOR_PBX.PRODUCTS, "children"),
    rootChildren: listEntries(pbx, CAPACITOR_PBX.ROOT_GROUP, "children"),
  };
}

function ensureInObjectList(pbx, objectId, listKey, entryLine) {
  const obj = objectBody(pbx, objectId);
  if (!obj) return pbx;
  const rel = obj.text.indexOf(`${listKey} = (`);
  if (rel < 0) return pbx;
  const abs = obj.start + rel;
  const open = pbx.indexOf("(", abs);
  if (open < 0 || open >= obj.end) return pbx;
  let depth = 0;
  let close = -1;
  for (let i = open; i < obj.end; i++) {
    if (pbx[i] === "(") depth++;
    else if (pbx[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return pbx;
  const listText = pbx.slice(open + 1, close);
  const entryId = entryLine.trim().split(/\s+/)[0];
  const already = [...listText.matchAll(/([A-F0-9]{24}) \/\*/g)].map((m) => m[1]);
  if (already.includes(entryId)) return pbx;
  const line = entryLine.endsWith("\n") ? entryLine : `${entryLine}\n`;
  const nl = pbx.indexOf("\n", open);
  if (nl < 0 || nl > close) {
    return `${pbx.slice(0, open + 1)}\n${line}\t\t\t${pbx.slice(open + 1)}`;
  }
  return `${pbx.slice(0, nl + 1)}${line}${pbx.slice(nl + 1)}`;
}

function patchPackageClassList(file, result, rel) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, "utf8");
  let json;
  try {
    json = JSON.parse(before);
  } catch {
    return;
  }
  const list = Array.isArray(json.packageClassList) ? json.packageClassList : [];
  const needed = ["RoutineAlarmsPlugin", "ScreenTimePlugin", "FamilyLocationPlugin", "FamilyPushPlugin"];
  const missing = needed.filter((name) => !list.includes(name));
  if (!missing.length) {
    result.record(`${rel(file)}: local plugins registered`, false);
    return;
  }
  json.packageClassList = [...list, ...missing];
  fs.writeFileSync(file, `${JSON.stringify(json, null, "\t")}\n`);
  result.record(`${rel(file)}: local plugins registered`, true);
}

function patchAlarmKitPbxproj(file, result, rel) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, "utf8");
  if (!before.includes("isa = PBXNativeTarget") || !before.includes("name = App;")) {
    return;
  }
  let after = before;
  after = injectPluginSources(after);
  after = injectScreenTimePluginSources(after);
  after = injectFamilyLocationPluginSources(after);
  after = injectFamilyPushPluginSources(after);
  after = injectWidgetTarget(after);
  after = injectScreenTimeReportTarget(after);
  after = restoreWidgetDeployment(after);
  after = restoreScreenTimeDeployment(after);
  after = ensureWeakAlarmKit(after);
  after = ensureAppEntitlementsSetting(after);
  if (after !== before) fs.writeFileSync(file, after);
  result.record(`${rel(file)}: RoutineAlarms, ScreenTime, FamilyLocation plugin, widget, and report extension`, after !== before);
}

function injectPluginSources(text) {
  if (!text.includes("/* Sources */") || !text.includes("AppDelegate.swift in Sources")) return text;
  let out = text;
  const groupId = pbxId("plugins-group");
  for (const relPath of PLUGIN_SOURCES) {
    const name = path.posix.basename(relPath);
    const fileRef = pbxId(`fileref:${relPath}`);
    const build = pbxId(`build:${relPath}`);
    out = insertSectionLine(
      out,
      "PBXBuildFile",
      `\t\t${build} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRef} /* ${name} */; };`
    );
    out = insertSectionLine(
      out,
      "PBXFileReference",
      `\t\t${fileRef} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${name}; sourceTree = "<group>"; };`
    );
    // Must inspect the App target Sources *files* list. A whole-file includes()
    // of `${build} /* Name in Sources */` is already true after PBXBuildFile
    // is inserted, which is what left these files out of Compile Sources.
    out = ensureInObjectList(
      out,
      CAPACITOR_PBX.APP_SOURCES,
      "files",
      `\t\t\t\t${build} /* ${name} in Sources */,`
    );
  }
  const appGroup = objectBody(out, "504EC3061FED79650016851F");
  const appChildren = appGroup ? extractParenList(appGroup.text, "children") || "" : "";
  if (!appChildren.includes(`${groupId} /* RoutineAlarms */`) && out.includes("50B271D01FEDC1A000F3C39B /* public */")) {
    const children = PLUGIN_SOURCES.map((relPath) => {
      const name = path.posix.basename(relPath);
      return `\t\t\t\t${pbxId(`fileref:${relPath}`)} /* ${name} */,`;
    }).join("\n");
    out = insertSectionLine(
      out,
      "PBXGroup",
      `\t\t${groupId} /* RoutineAlarms */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n${children}\n\t\t\t);\n\t\t\tpath = Plugins/RoutineAlarms;\n\t\t\tsourceTree = "<group>";\n\t\t};`
    );
    out = ensureInObjectList(
      out,
      "504EC3061FED79650016851F",
      "children",
      `\t\t\t\t${groupId} /* RoutineAlarms */,`
    );
  }
  return out;
}

function injectSwiftSources(text, sources, groupKey, groupComment, groupPath) {
  if (!text.includes("/* Sources */") || !text.includes("AppDelegate.swift in Sources")) return text;
  let out = text;
  const groupId = pbxId(groupKey);
  for (const relPath of sources) {
    const name = path.posix.basename(relPath);
    const fileRef = pbxId(`fileref:${relPath}`);
    const build = pbxId(`build:${relPath}`);
    out = insertSectionLine(
      out,
      "PBXBuildFile",
      `\t\t${build} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRef} /* ${name} */; };`
    );
    out = insertSectionLine(
      out,
      "PBXFileReference",
      `\t\t${fileRef} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${name}; sourceTree = "<group>"; };`
    );
    out = ensureInObjectList(
      out,
      CAPACITOR_PBX.APP_SOURCES,
      "files",
      `\t\t\t\t${build} /* ${name} in Sources */,`
    );
  }
  const appGroup = objectBody(out, "504EC3061FED79650016851F");
  const appChildren = appGroup ? extractParenList(appGroup.text, "children") || "" : "";
  if (!appChildren.includes(`${groupId} /* ${groupComment} */`) && out.includes("50B271D01FEDC1A000F3C39B /* public */")) {
    const children = sources
      .map((relPath) => {
        const name = path.posix.basename(relPath);
        return `\t\t\t\t${pbxId(`fileref:${relPath}`)} /* ${name} */,`;
      })
      .join("\n");
    out = insertSectionLine(
      out,
      "PBXGroup",
      `\t\t${groupId} /* ${groupComment} */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n${children}\n\t\t\t);\n\t\t\tpath = ${groupPath};\n\t\t\tsourceTree = "<group>";\n\t\t};`
    );
    out = ensureInObjectList(
      out,
      "504EC3061FED79650016851F",
      "children",
      `\t\t\t\t${groupId} /* ${groupComment} */,`
    );
  }
  return out;
}

function injectScreenTimePluginSources(text) {
  return injectSwiftSources(
    text,
    SCREEN_TIME_PLUGIN_SOURCES,
    "screentime-plugins-group",
    "ScreenTime",
    "Plugins/ScreenTime"
  );
}

function injectFamilyLocationPluginSources(text) {
  return injectSwiftSources(
    text,
    FAMILY_LOCATION_PLUGIN_SOURCES,
    "familylocation-plugins-group",
    "FamilyLocation",
    "Plugins/FamilyLocation"
  );
}

function injectFamilyPushPluginSources(text) {
  return injectSwiftSources(
    text,
    FAMILY_PUSH_PLUGIN_SOURCES,
    "familypush-plugins-group",
    "FamilyPush",
    "Plugins/FamilyPush"
  );
}

function appDevelopmentTeamLine(pbx) {
  const obj = objectBody(pbx, "504EC3171FED79650016851F");
  if (!obj) return "";
  const match = obj.text.match(/DEVELOPMENT_TEAM = ([A-Z0-9]+);/);
  return match ? `\n\t\t\t\tDEVELOPMENT_TEAM = ${match[1]};` : "";
}

function injectScreenTimeReportTarget(text) {
  const ids = screenTimePbxIds();
  const storeRef = pbxId("fileref:App/Plugins/ScreenTime/ScreenTimeStore.swift");
  const widgetIds = widgetPbxIds();
  let out = text;
  const team = appDevelopmentTeamLine(out);

  out = insertSectionLine(
    out,
    "PBXBuildFile",
    `\t\t${ids.swiftBuild} /* ScreenTimeReport.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${ids.swift} /* ScreenTimeReport.swift */; };`
  );
  out = insertSectionLine(
    out,
    "PBXBuildFile",
    `\t\t${ids.storeBuild} /* ScreenTimeStore.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${storeRef} /* ScreenTimeStore.swift */; };`
  );
  out = insertSectionLine(
    out,
    "PBXBuildFile",
    `\t\t${ids.embedBuild} /* ScreenTimeReport.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ${ids.product} /* ScreenTimeReport.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };`
  );
  out = insertSectionLine(
    out,
    "PBXFileReference",
    `\t\t${ids.product} /* ScreenTimeReport.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = ScreenTimeReport.appex; sourceTree = BUILT_PRODUCTS_DIR; };`
  );
  out = insertSectionLine(
    out,
    "PBXFileReference",
    `\t\t${ids.swift} /* ScreenTimeReport.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ScreenTimeReport.swift; sourceTree = "<group>"; };`
  );
  out = insertSectionLine(
    out,
    "PBXFileReference",
    `\t\t${ids.info} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };`
  );
  out = insertSectionLine(
    out,
    "PBXFileReference",
    `\t\t${ids.entitlements} /* ScreenTimeReport.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = ScreenTimeReport.entitlements; sourceTree = "<group>"; };`
  );
  out = insertSectionLine(
    out,
    "PBXGroup",
    `\t\t${ids.group} /* ScreenTimeReport */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t${ids.swift} /* ScreenTimeReport.swift */,\n\t\t\t\t${ids.info} /* Info.plist */,\n\t\t\t\t${ids.entitlements} /* ScreenTimeReport.entitlements */,\n\t\t\t);\n\t\t\tpath = ScreenTimeReport;\n\t\t\tsourceTree = "<group>";\n\t\t};`
  );
  out = insertSectionLine(
    out,
    "PBXFrameworksBuildPhase",
    `\t\t${ids.frameworks} /* Frameworks */ = {\n\t\t\tisa = PBXFrameworksBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};`
  );
  out = insertSectionLine(
    out,
    "PBXSourcesBuildPhase",
    `\t\t${ids.sources} /* Sources */ = {\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t\t${ids.swiftBuild} /* ScreenTimeReport.swift in Sources */,\n\t\t\t\t${ids.storeBuild} /* ScreenTimeStore.swift in Sources */,\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};`
  );
  out = insertSectionLine(
    out,
    "PBXResourcesBuildPhase",
    `\t\t${ids.resources} /* Resources */ = {\n\t\t\tisa = PBXResourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};`
  );
  out = insertSectionLine(
    out,
    "PBXContainerItemProxy",
    `\t\t${ids.proxy} /* PBXContainerItemProxy */ = {\n\t\t\tisa = PBXContainerItemProxy;\n\t\t\tcontainerPortal = 504EC2FC1FED79650016851F /* Project object */;\n\t\t\tproxyType = 1;\n\t\t\tremoteGlobalIDString = ${ids.target};\n\t\t\tremoteInfo = ScreenTimeReport;\n\t\t};`
  );
  out = insertSectionLine(
    out,
    "PBXTargetDependency",
    `\t\t${ids.dep} /* PBXTargetDependency */ = {\n\t\t\tisa = PBXTargetDependency;\n\t\t\ttarget = ${ids.target} /* ScreenTimeReport */;\n\t\t\ttargetProxy = ${ids.proxy} /* PBXContainerItemProxy */;\n\t\t};`
  );
  out = insertSectionLine(
    out,
    "PBXNativeTarget",
    `\t\t${ids.target} /* ScreenTimeReport */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = ${ids.configList} /* Build configuration list for PBXNativeTarget "ScreenTimeReport" */;\n\t\t\tbuildPhases = (\n\t\t\t\t${ids.sources} /* Sources */,\n\t\t\t\t${ids.frameworks} /* Frameworks */,\n\t\t\t\t${ids.resources} /* Resources */,\n\t\t\t);\n\t\t\tbuildRules = (\n\t\t\t);\n\t\t\tdependencies = (\n\t\t\t);\n\t\t\tname = ScreenTimeReport;\n\t\t\tproductName = ScreenTimeReport;\n\t\t\tproductReference = ${ids.product} /* ScreenTimeReport.appex */;\n\t\t\tproductType = "com.apple.product-type.app-extension";\n\t\t};`
  );

  out = ensureInObjectList(out, CAPACITOR_PBX.PROJECT, "targets", `\t\t\t\t${ids.target} /* ScreenTimeReport */,`);
  out = ensureInObjectList(out, CAPACITOR_PBX.APP_TARGET, "dependencies", `\t\t\t\t${ids.dep} /* PBXTargetDependency */,`);
  out = ensureInObjectList(out, CAPACITOR_PBX.PRODUCTS, "children", `\t\t\t\t${ids.product} /* ScreenTimeReport.appex */,`);
  out = ensureInObjectList(out, CAPACITOR_PBX.ROOT_GROUP, "children", `\t\t\t\t${ids.group} /* ScreenTimeReport */,`);
  out = ensureInObjectList(
    out,
    widgetIds.embed,
    "files",
    `\t\t\t\t${ids.embedBuild} /* ScreenTimeReport.appex in Embed Foundation Extensions */,`
  );

  const reportSettings = (name) => `\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tCODE_SIGN_ENTITLEMENTS = ScreenTimeReport/ScreenTimeReport.entitlements;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;${team}
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = ScreenTimeReport/Info.plist;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 26.0;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks";
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = app.routine.calendar.ScreenTimeReport;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSKIP_INSTALL = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1";
\t\t\t};
\t\t\tname = ${name};`;

  out = insertSectionLine(out, "XCBuildConfiguration", `\t\t${ids.debug} /* Debug */ = {\n${reportSettings("Debug")}\n\t\t};`);
  out = insertSectionLine(out, "XCBuildConfiguration", `\t\t${ids.release} /* Release */ = {\n${reportSettings("Release")}\n\t\t};`);
  out = insertSectionLine(
    out,
    "XCConfigurationList",
    `\t\t${ids.configList} /* Build configuration list for PBXNativeTarget "ScreenTimeReport" */ = {\n\t\t\tisa = XCConfigurationList;\n\t\t\tbuildConfigurations = (\n\t\t\t\t${ids.debug} /* Debug */,\n\t\t\t\t${ids.release} /* Release */,\n\t\t\t);\n\t\t\tdefaultConfigurationIsVisible = 0;\n\t\t\tdefaultConfigurationName = Release;\n\t\t};`
  );
  return out;
}

export function screenTimePbxIds() {
  return {
    product: screenTimePbxId("report-product"),
    target: screenTimePbxId("report-target"),
    sources: screenTimePbxId("report-sources"),
    frameworks: screenTimePbxId("report-frameworks"),
    resources: screenTimePbxId("report-resources"),
    configList: screenTimePbxId("report-config-list"),
    debug: screenTimePbxId("report-debug"),
    release: screenTimePbxId("report-release"),
    embedBuild: screenTimePbxId("report-embed-build"),
    proxy: screenTimePbxId("report-proxy"),
    dep: screenTimePbxId("report-dep"),
    swift: screenTimePbxId("report-swift"),
    swiftBuild: screenTimePbxId("report-swift-build"),
    storeBuild: screenTimePbxId("report-store-build"),
    info: screenTimePbxId("report-info"),
    entitlements: screenTimePbxId("report-entitlements"),
    group: screenTimePbxId("report-group"),
  };
}

function injectWidgetTarget(text) {
  // Never early-return just because the native target object exists. A previous
  // run can leave RoutineAlarmWidget declared but unwired (not in
  // PBXProject.targets, App.buildPhases, App.dependencies, or Products).
  const ids = widgetPbxIds();
  const metaRef = pbxId("fileref:App/Plugins/RoutineAlarms/RoutineAlarmMetadata.swift");
  let out = text;

  out = insertSectionLine(
    out,
    "PBXBuildFile",
    `\t\t${ids.swiftBuild} /* RoutineAlarmLiveActivity.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${ids.swift} /* RoutineAlarmLiveActivity.swift */; };`
  );
  out = insertSectionLine(
    out,
    "PBXBuildFile",
    `\t\t${ids.metaBuild} /* RoutineAlarmMetadata.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${metaRef} /* RoutineAlarmMetadata.swift */; };`
  );
  out = insertSectionLine(
    out,
    "PBXBuildFile",
    `\t\t${ids.embedBuild} /* RoutineAlarmWidget.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ${ids.product} /* RoutineAlarmWidget.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };`
  );
  out = insertSectionLine(
    out,
    "PBXFileReference",
    `\t\t${ids.product} /* RoutineAlarmWidget.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = RoutineAlarmWidget.appex; sourceTree = BUILT_PRODUCTS_DIR; };`
  );
  out = insertSectionLine(
    out,
    "PBXFileReference",
    `\t\t${ids.swift} /* RoutineAlarmLiveActivity.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = RoutineAlarmLiveActivity.swift; sourceTree = "<group>"; };`
  );
  out = insertSectionLine(
    out,
    "PBXFileReference",
    `\t\t${ids.info} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };`
  );

  out = insertSectionLine(
    out,
    "PBXGroup",
    `\t\t${ids.group} /* RoutineAlarmWidget */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t${ids.swift} /* RoutineAlarmLiveActivity.swift */,\n\t\t\t\t${ids.info} /* Info.plist */,\n\t\t\t);\n\t\t\tpath = RoutineAlarmWidget;\n\t\t\tsourceTree = "<group>";\n\t\t};`
  );

  out = insertSectionLine(
    out,
    "PBXFrameworksBuildPhase",
    `\t\t${ids.frameworks} /* Frameworks */ = {\n\t\t\tisa = PBXFrameworksBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};`
  );
  out = insertSectionLine(
    out,
    "PBXSourcesBuildPhase",
    `\t\t${ids.sources} /* Sources */ = {\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t\t${ids.swiftBuild} /* RoutineAlarmLiveActivity.swift in Sources */,\n\t\t\t\t${ids.metaBuild} /* RoutineAlarmMetadata.swift in Sources */,\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};`
  );
  out = insertSectionLine(
    out,
    "PBXResourcesBuildPhase",
    `\t\t${ids.resources} /* Resources */ = {\n\t\t\tisa = PBXResourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};`
  );
  if (!objectBody(out, ids.embed)) {
    out = insertSectionLine(
      out,
      "PBXCopyFilesBuildPhase",
      `\t\t${ids.embed} /* Embed Foundation Extensions */ = {\n\t\t\tisa = PBXCopyFilesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tdstPath = "";\n\t\t\tdstSubfolderSpec = 13;\n\t\t\tfiles = (\n\t\t\t);\n\t\t\tname = "Embed Foundation Extensions";\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};`
    );
  }
  out = ensureInObjectList(
    out,
    ids.embed,
    "files",
    `\t\t\t\t${ids.embedBuild} /* RoutineAlarmWidget.appex in Embed Foundation Extensions */,`
  );
  out = insertSectionLine(
    out,
    "PBXContainerItemProxy",
    `\t\t${ids.proxy} /* PBXContainerItemProxy */ = {\n\t\t\tisa = PBXContainerItemProxy;\n\t\t\tcontainerPortal = 504EC2FC1FED79650016851F /* Project object */;\n\t\t\tproxyType = 1;\n\t\t\tremoteGlobalIDString = ${ids.target};\n\t\t\tremoteInfo = RoutineAlarmWidget;\n\t\t};`
  );
  out = insertSectionLine(
    out,
    "PBXTargetDependency",
    `\t\t${ids.dep} /* PBXTargetDependency */ = {\n\t\t\tisa = PBXTargetDependency;\n\t\t\ttarget = ${ids.target} /* RoutineAlarmWidget */;\n\t\t\ttargetProxy = ${ids.proxy} /* PBXContainerItemProxy */;\n\t\t};`
  );
  out = insertSectionLine(
    out,
    "PBXNativeTarget",
    `\t\t${ids.target} /* RoutineAlarmWidget */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = ${ids.configList} /* Build configuration list for PBXNativeTarget "RoutineAlarmWidget" */;\n\t\t\tbuildPhases = (\n\t\t\t\t${ids.sources} /* Sources */,\n\t\t\t\t${ids.frameworks} /* Frameworks */,\n\t\t\t\t${ids.resources} /* Resources */,\n\t\t\t);\n\t\t\tbuildRules = (\n\t\t\t);\n\t\t\tdependencies = (\n\t\t\t);\n\t\t\tname = RoutineAlarmWidget;\n\t\t\tproductName = RoutineAlarmWidget;\n\t\t\tproductReference = ${ids.product} /* RoutineAlarmWidget.appex */;\n\t\t\tproductType = "com.apple.product-type.app-extension";\n\t\t};`
  );

  // Section/target-scoped list membership. Global includes() is already true
  // once the native-target / embed-phase / file-ref objects exist.
  out = ensureInObjectList(
    out,
    CAPACITOR_PBX.PROJECT,
    "targets",
    `\t\t\t\t${ids.target} /* RoutineAlarmWidget */,`
  );
  out = ensureInObjectList(
    out,
    CAPACITOR_PBX.APP_TARGET,
    "buildPhases",
    `\t\t\t\t${ids.embed} /* Embed Foundation Extensions */,`
  );
  out = ensureInObjectList(
    out,
    CAPACITOR_PBX.APP_TARGET,
    "dependencies",
    `\t\t\t\t${ids.dep} /* PBXTargetDependency */,`
  );
  out = ensureInObjectList(
    out,
    CAPACITOR_PBX.PRODUCTS,
    "children",
    `\t\t\t\t${ids.product} /* RoutineAlarmWidget.appex */,`
  );
  out = ensureInObjectList(
    out,
    CAPACITOR_PBX.ROOT_GROUP,
    "children",
    `\t\t\t\t${ids.group} /* RoutineAlarmWidget */,`
  );

  const widgetSettings = (name) => `\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = RoutineAlarmWidget/Info.plist;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 26.0;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks";
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = app.routine.calendar.RoutineAlarmWidget;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSKIP_INSTALL = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1";
\t\t\t};
\t\t\tname = ${name};`;

  out = insertSectionLine(
    out,
    "XCBuildConfiguration",
    `\t\t${ids.debug} /* Debug */ = {\n${widgetSettings("Debug")}\n\t\t};`
  );
  out = insertSectionLine(
    out,
    "XCBuildConfiguration",
    `\t\t${ids.release} /* Release */ = {\n${widgetSettings("Release")}\n\t\t};`
  );
  out = insertSectionLine(
    out,
    "XCConfigurationList",
    `\t\t${ids.configList} /* Build configuration list for PBXNativeTarget "RoutineAlarmWidget" */ = {\n\t\t\tisa = XCConfigurationList;\n\t\t\tbuildConfigurations = (\n\t\t\t\t${ids.debug} /* Debug */,\n\t\t\t\t${ids.release} /* Release */,\n\t\t\t);\n\t\t\tdefaultConfigurationIsVisible = 0;\n\t\t\tdefaultConfigurationName = Release;\n\t\t};`
  );
  return out;
}

function restoreWidgetDeployment(text) {
  const marker = "PRODUCT_BUNDLE_IDENTIFIER = app.routine.calendar.RoutineAlarmWidget;";
  if (!text.includes(marker)) return text;
  return text.replace(
    /(\t\t[A-F0-9]{24} \/\* (?:Debug|Release) \*\/ = \{\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = \{[\s\S]*?\n\t\t\};)/g,
    (block) => {
      if (!block.includes(marker)) return block;
      return block.replace(/IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;/, "IPHONEOS_DEPLOYMENT_TARGET = 26.0;");
    }
  );
}

function restoreScreenTimeDeployment(text) {
  const marker = "PRODUCT_BUNDLE_IDENTIFIER = app.routine.calendar.ScreenTimeReport;";
  if (!text.includes(marker)) return text;
  return text.replace(
    /(\t\t[A-F0-9]{24} \/\* (?:Debug|Release) \*\/ = \{\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = \{[\s\S]*?\n\t\t\};)/g,
    (block) => {
      if (!block.includes(marker)) return block;
      return block.replace(/IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;/, "IPHONEOS_DEPLOYMENT_TARGET = 26.0;");
    }
  );
}

function ensureBuildSettingLine(pbx, configId, key, line) {
  const obj = objectBody(pbx, configId);
  if (!obj) return pbx;
  if (obj.text.includes(`${key} =`)) return pbx;
  const needle = "buildSettings = {";
  const rel = obj.text.indexOf(needle);
  if (rel < 0) return pbx;
  const abs = obj.start + rel + needle.length;
  return `${pbx.slice(0, abs)}\n\t\t\t\t${line}${pbx.slice(abs)}`;
}

function ensureAppEntitlementsSetting(text) {
  let out = text;
  out = ensureBuildSettingLine(
    out,
    "504EC3171FED79650016851F",
    "CODE_SIGN_ENTITLEMENTS",
    "CODE_SIGN_ENTITLEMENTS = App/App.entitlements;"
  );
  out = ensureBuildSettingLine(
    out,
    "504EC3181FED79650016851F",
    "CODE_SIGN_ENTITLEMENTS",
    "CODE_SIGN_ENTITLEMENTS = App/App.entitlements;"
  );
  return out;
}

function writeIfChanged(file, contents, result, rel, label) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (before === contents) {
    result.record(label, false);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  result.record(label, true);
}

function patchScreenTimeEntitlements(projectRoot, result, rel) {
  const pbx = path.join(projectRoot, "ios", "App", "App.xcodeproj", "project.pbxproj");
  if (!fs.existsSync(pbx)) return;
  const text = fs.readFileSync(pbx, "utf8");
  if (!text.includes("isa = PBXNativeTarget") || !text.includes("name = App;")) return;
  const appEnt = path.join(projectRoot, "ios", "App", "App", "App.entitlements");
  const reportEnt = path.join(projectRoot, "ios", "App", "ScreenTimeReport", "ScreenTimeReport.entitlements");
  writeIfChanged(appEnt, APP_PUSH_FAMILY_ENTITLEMENTS, result, rel, `${rel(appEnt)}: Family Controls and Push entitlements`);
  writeIfChanged(
    reportEnt,
    FAMILY_CONTROLS_ENTITLEMENTS,
    result,
    rel,
    `${rel(reportEnt)}: Family Controls entitlements`
  );
}

function ensureWeakAlarmKit(text) {
  if (text.includes("-weak_framework AlarmKit")) return text;
  return text.replace(
    /(504EC3171FED79650016851F \/\* Debug \*\/ = \{[\s\S]*?buildSettings = \{)/,
    `$1\n\t\t\t\tOTHER_LDFLAGS = "$(inherited) -weak_framework AlarmKit -weak_framework ActivityKit";`
  ).replace(
    /(504EC3181FED79650016851F \/\* Release \*\/ = \{[\s\S]*?buildSettings = \{)/,
    `$1\n\t\t\t\tOTHER_LDFLAGS = "$(inherited) -weak_framework AlarmKit -weak_framework ActivityKit";`
  );
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
  patchAlarmKitPbxproj(targets.pbxproj, result, rel);
  patchScreenTimeEntitlements(projectRoot, result, rel);
  patchInfoPlist(targets.infoPlist, result, rel);
  patchPackageClassList(targets.capConfig, result, rel);
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
