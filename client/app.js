import { DEFAULT_SETTINGS } from "/shared/defaults.js";
import { planRange, warningsFor, mergePlan, dedupeEvents } from "/shared/scheduler.js";
import {
  addDays,
  clipToDay,
  durationMin,
  eachDate,
  fmtRange,
  fmtTime,
  fromISO,
  isoDate,
  overlapsDay,
  startOfWeek,
  uid,
} from "/shared/time.js";
import { ensurePermission, tickAlarms } from "./alarms.js";
import { bootNative, haptic, isNative, onAppActive, plugin } from "./native.js";
import { bannerHtml, bindInstallBanner, enableAlarmsFromBanner, alarmsStatusLabel, isStandalone, needsAlarmSetup, notificationPermission, onInstallChange, setupInstall } from "./install.js";
import { setupWebPush } from "./push.js";
import {
  cancelTestAlarm,
  cancelTestNotification,
  enableAlarms,
  enableNotifications,
  getDiagnostics,
  nativeSupportFromProbe,
  prepareForegroundSync,
  probeNativePermissions,
  probeTestAlarmAuthorization,
  refreshTickGate,
  runtimeMode,
  scheduleTestAlarm,
  scheduleTestNotification,
  submitWakeChallenge,
  syncAll,
} from "./routine-alarms.js";
import { wakeVerificationSettings } from "/shared/alarm-plan.js";
import { CAT, DAD_WHATSAPP, DAYS_LONG, DAYS_SHORT, MONTHS, TONE, WEEK_HD, needsDadCall, prettyDur, prettyNotes, prettyTitle, prettyWarn } from "./copy.js";
import { ensurePlaces, geocode, roundLeaveLocal, routeBetween, DEFAULT_MODE } from "/shared/travel.js";
import { trafficFromRoute } from "/shared/school-leave.js";
import { systemTimeZone } from "/shared/tz.js";
import { bindMap, bindPlaceSheet, destroyFamilyMap, destroyMap, destroyPlaceMap, mapViewHtml, paintFamilyMap, placeSheetHtml } from "./map-tab.js";
import {
  attachScreenTimeReport,
  chooseScreenTimeApps,
  detachScreenTimeReport,
  enableScreenTime,
  screenTimeStatus,
} from "./screen-time.js";
import {
  familyChangePassword,
  familyDeleteHistory,
  familyGetLocation,
  familyLogout,
  familyMe,
  familyPulse,
  familySetHome,
  familySignIn,
  familyToken,
} from "./family-api.js";
import { registerFamilyPush } from "./family-push.js";
import {
  familyLocationStatus,
  requestAlwaysLocation,
  requestWhenInUseLocation,
  startFamilyLocationSharing,
  stopFamilyLocationSharing,
} from "./family-location.js";
import {
  changePasswordHtml,
  familyLoginHtml,
  memberEnableLocationHtml,
  memberSignOutHtml,
  parentMapHtml,
  parentNavHtml,
  parentSettingsHtml,
} from "./family-ui.js";
import { timeInputToMinutes } from "/shared/family.js";

const root = document.getElementById("app");
const ui = {
  view: "today",
  selected: isoDate(new Date()),
  monthCursor: isoDate(new Date()).slice(0, 7),
  sheet: null,
  native: null,
  diag: null,
  diagMsg: "",
  alarmKitSupport: { loaded: false },
  notificationAuth: null,
  challenge: null,
  challengeInput: "",
  challengeError: "",
  testAlarmMsg: "",
  activityRange: "today",
  activityMsg: "",
  screenTime: null,
  familyMe: null,
  watchedMember: "anika",
  familyLoc: null,
  familyLocStatus: null,
  familyMsg: "",
  passwordMsg: "",
  travel: {
    purpose: "office",
    fromId: "place_home",
    toId: "place_office",
    mode: DEFAULT_MODE,
    leaveAt: roundLeaveLocal(),
    here: null,
    preview: null,
    error: "",
  },
};

let state = {
  settings: { ...DEFAULT_SETTINGS },
  shifts: {},
  events: [],
  notes: [],
  warnings: [],
};

function watchedMember() {
  return ui.watchedMember || "anika";
}

function memberCacheKey() {
  const name = ui.familyMe?.user?.username;
  return name ? `routine-state:${name}` : "routine-state";
}

function resetRoutineMemory() {
  state = {
    settings: { ...DEFAULT_SETTINGS },
    shifts: {},
    events: [],
    notes: [],
    warnings: [],
    places: [],
  };
}

async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const token = familyToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(path, {
      ...opts,
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function applyLoadedState(next) {
  state = next || {};
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  enforceMandatoryAlarms();
  state.events = dedupeEvents(state.events || []);
  state.notes = state.notes || [];
  state.shifts = {};
  const tz = systemTimeZone();
  if (state.settings.timeZone !== tz) state.settings.timeZone = tz;
  state.places = ensurePlaces(state.places);
}

async function loadMemberRoutine() {
  try {
    applyLoadedState(await api("/api/state"));
  } catch {
    try {
      const cached = localStorage.getItem(memberCacheKey());
      if (cached) applyLoadedState({ ...state, ...JSON.parse(cached) });
      else resetRoutineMemory();
    } catch {
      resetRoutineMemory();
    }
    applyLoadedState(state);
  }
  persistLocal();
  try {
    await api("/api/state", { method: "PUT", body: JSON.stringify(state) });
  } catch {
    /* offline */
  }
}

async function load() {
  try {
    const me = await familyMe();
    ui.familyMe = me.ok ? me : null;
    if (isParent() && (ui.view === "today" || ui.view === "overview" || ui.view === "activity")) {
      ui.view = "map";
    }
  } catch {
    ui.familyMe = null;
  }
  if (isMember()) await loadMemberRoutine();
  else if (!isParent()) resetRoutineMemory();
  render();
  void pulsePresence();
  if (isMember()) void refreshSchoolWalk().then(() => syncAll(state, "school-walk")).catch(() => {});
  if (isParent()) {
    familyGetLocation(watchedMember())
      .then((loc) => {
        ui.familyLoc = loc;
        if (ui.view === "map" || ui.view === "settings") render();
      })
      .catch(() => {});
    if (isNative()) void registerFamilyPush();
  } else if (isMember()) {
    familyLocationStatus()
      .then((st) => {
        ui.familyLocStatus = st;
      })
      .catch(() => {});
  }
  if (isNative()) {
    probeNativePermissions()
      .then(async (probe) => {
        ui.native = probe;
        ui.notificationAuth = probe.notifications;
        ui.alarmKitSupport = {
          loaded: true,
          supported: Boolean(probe.alarms?.support?.supported),
          authorization: probe.alarms?.authorization || "unavailable",
          osVersion: probe.alarms?.support?.osVersion || null,
        };
        await refreshTickGate();
        if (ui.view === "settings") render();
      })
      .catch(() => {});
  }
  try {
    const { pending } = await prepareForegroundSync(state, "state-loaded");
    if (pending?.active) {
      ui.challenge = pending;
      ui.challengeInput = ui.challengeInput || "";
      render();
    } else {
      ui.challenge = null;
    }
  } catch {
    ui.challenge = null;
  }
}

function persistLocal() {
  if (!isMember()) return;
  localStorage.setItem(memberCacheKey(), JSON.stringify(state));
}

function clientPlatform() {
  if (isNative()) return "iPhone";
  const ua = navigator.userAgent || "";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac/i.test(ua)) return "Mac";
  if (/iPhone|iPad/i.test(ua)) return "iPhone";
  return "Web";
}

async function pulsePresence() {
  try {
    await familyPulse(clientPlatform());
  } catch {
    /* offline */
  }
}

async function refreshSchoolWalk() {
  const home = (state.places || []).find((p) => p.purpose === "home" && p.lat != null);
  const school = (state.places || []).find(
    (p) => p.lat != null && (p.purpose === "office" || /school/i.test(p.name || "") || /school/i.test(p.purpose || ""))
  );
  if (!home || !school) return false;
  try {
    const route = await routeBetween(home, school, "walking");
    const normal = state.settings.schoolWalkMin || 10;
    const lead = trafficFromRoute(route.min, normal);
    const prevTraffic = state.settings.schoolTrafficMin || 0;
    state.settings.schoolWalkMin = lead.walkMin;
    state.settings.schoolTrafficMin = lead.trafficMin;
    return lead.trafficMin !== prevTraffic;
  } catch {
    return false;
  }
}

async function save() {
  if (!isMember()) return;
  persistLocal();
  try {
    await api("/api/state", { method: "PUT", body: JSON.stringify(state) });
  } catch {
    /* offline */
  }
}

let planning = false;

async function generate() {
  if (planning) return;
  planning = true;
  haptic("medium");
  const from = startOfWeek(ui.selected);
  const to = addDays(from, 13);
  const prev = state.events || [];
  try {
    try {
      state = await api("/api/plan", { method: "POST", body: JSON.stringify({ from, to }) });
      state.events = dedupeEvents(state.events || []);
    } catch {
      const userEvents = prev.filter((e) => e.source === "user" || e.kind === "class" || e.kind === "sleep");
      const keep = prev.filter((e) => e.locked);
      const generated = planRange({
        userEvents,
        keep,
        from,
        to,
      });
      state.events = mergePlan(prev, generated, from, to);
      state.warnings = warningsFor(generated, state.shifts, state.settings);
      state.generatedAt = new Date().toISOString();
    }
    await save();
    await syncAll(state, "generate");
    render();
  } finally {
    planning = false;
  }
}

function openEvent(id) {
  const event = state.events.find((x) => x.id === id);
  if (!event) return;
  ui.sheet = { type: "event", event: { ...event } };
  render();
}

async function removeEvent(id) {
  const event = state.events.find((x) => x.id === id);
  const name = event?.title || "this event";
  if (!confirm(`Remove “${name}”?`)) return;
  const rootId = event?.occurrenceOf || id;
  state.events = state.events.filter(
    (e) => e.id !== id && e.id !== rootId && e.occurrenceOf !== rootId
  );
  ui.sheet = null;
  haptic("warning");
  await save();
  await syncAll(state, "event-removed");
  render();
}

function enforceMandatoryAlarms() {
  const s = state.settings || (state.settings = { ...DEFAULT_SETTINGS });
  s.alarmsEnabled = true;
  s.wakeAlarms = true;
  s.classAlarms = true;
  s.leaveAlarms = true;
  s.beforeSleepNotes = true;
  s.wakeVerificationEnabled = true;
  s.backupAlarmCount = 4;
  s.backupIntervalSec = 30;
}

const EVENT_TYPES = [
  ["class", "Class"],
  ["sleep", "Sleep"],
  ["commuteCall", "Call parent"],
  ["meal", "Meal"],
  ["prayer", "JK"],
  ["study", "MCAT"],
  ["gym", "Gym"],
  ["chore", "Chore"],
  ["personal", "Personal"],
  ["commute", "Commute"],
];

function kindForCategory(category) {
  if (category === "class") return "class";
  if (category === "sleep") return "sleep";
  if (category === "commuteCall") return "call-parents";
  return category || "personal";
}

function durationForCategory(category) {
  if (category === "class") return 50;
  if (category === "sleep") return 8 * 60;
  if (category === "commuteCall") return 15;
  return 60;
}

function eventTypeOptions(current) {
  const options = EVENT_TYPES.slice();
  if (current && !options.some(([key]) => key === current)) options.push([current, CAT[current] || current]);
  return options;
}

function sleepQuestionOpen(now = Date.now()) {
  return (state.events || []).some((e) => {
    if (e.kind !== "sleep") return false;
    const start = Date.parse(e.start);
    if (!Number.isFinite(start)) return false;
    return now >= start - 10 * 60000 && now < start;
  });
}

function noteWhen(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function eventsOn(date) {
  return dedupeEvents(state.events || [])
    .filter((e) => overlapsDay(e.start, e.end, date))
    .sort((a, b) => fromISO(a.start) - fromISO(b.start));
}

function shiftClass(code) {
  if (!code) return "OFF";
  return code.replace("+", "");
}

function heading() {
  const d = new Date(ui.selected + "T12:00:00");
  return `${DAYS_LONG[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function isParent() {
  return ui.familyMe?.ok && ui.familyMe.user?.role === "parent";
}

function isMember() {
  return ui.familyMe?.ok && ui.familyMe.user?.role === "member";
}

async function refreshFamily() {
  ui.familyMe = await familyMe();
  if (isParent()) ui.familyLoc = await familyGetLocation(watchedMember());
  if (isMember()) ui.familyLocStatus = await familyLocationStatus();
}

let paintQueued = 0;

function render() {
  if (paintQueued) return;
  paintQueued = requestAnimationFrame(() => {
    paintQueued = 0;
    paint();
  });
}

function memberDayChrome() {
  if (ui.view !== "today") return "";
  const date = ui.selected;
  return `
    ${bannerHtml()}
    <header class="hero">
      <div class="top">
        <div>
          <h1 class="brand">Smart <span>Routine</span></h1>
          <p class="lede">Tap Add event for a class, sleep, or a call to Dad.</p>
        </div>
      </div>
    </header>
    ${weekBar()}
    <div class="dayhead">
      <strong>${heading()}</strong>
      <button class="btn small" id="todayBtn">Today</button>
    </div>
    ${(state.warnings || [])
      .filter((w) => w.date === date)
      .map((w) => `<div class="warn">${escapeHtml(prettyWarn(w.text))}</div>`)
      .join("")}`;
}

function paint() {
  try {
  if (ui.challenge?.active) {
    root.innerHTML = challengeHtml();
    bindChallenge();
    return;
  }
  if (!ui.familyMe?.ok) {
    root.innerHTML = familyLoginHtml(escapeHtml, ui.familyMsg);
    bindFamilyLogin();
    return;
  }
  if (isParent()) {
    renderParent();
    return;
  }
  if (ui.view === "overview") ui.view = "today";
  root.innerHTML = `
    ${memberDayChrome()}
    ${viewBody()}
    <nav class="nav nav-6" aria-label="Main">
      <button class="${ui.view === "today" ? "primary" : ""}" data-view="today">${navIcon("day")}<span>Day</span></button>
      <button class="${ui.view === "month" ? "primary" : ""}" data-view="month">${navIcon("month")}<span>Month</span></button>
      <button class="${ui.view === "map" ? "primary" : ""}" data-view="map">${navIcon("map")}<span>Map</span></button>
      <button class="${ui.view === "notes" ? "primary" : ""}" data-view="notes">${navIcon("notes")}<span>Notes</span></button>
      <button class="${ui.view === "activity" ? "primary" : ""}" data-view="activity">${navIcon("activity")}<span>Activity</span></button>
      <button class="${ui.view === "settings" ? "primary" : ""}" data-view="settings">${navIcon("set")}<span>Set</span></button>
    </nav>
    ${ui.sheet ? sheetHtml() : ""}
  `;
  bind();
  bindInstallBanner(root);
  } catch (err) {
    console.error(err);
    root.innerHTML = `<header class="hero"><h1 class="brand">Smart <span>Routine</span></h1><p class="lede">Something went wrong. Refresh the page.</p></header>`;
  }
}

function weekBar() {
  const start = startOfWeek(ui.selected);
  const days = eachDate(start, addDays(start, 6));
  return `<div class="weekbar">${days
    .map((d) => {
      const dt = new Date(d + "T12:00:00");
      return `<button class="daychip ${d === ui.selected ? "on" : ""}" data-day="${d}">
        <div class="d">${DAYS_SHORT[dt.getDay()]}</div>
        <div class="n">${dt.getDate()}</div>
      </button>`;
    })
    .join("")}</div>`;
}

function navIcon(name) {
  const icons = {
    day: '<svg class="nav-ico" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="gDay" x1="6" y1="4" x2="26" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#ffd7e6"/><stop offset="1" stop-color="#e45d88"/></linearGradient></defs><rect x="5" y="6" width="22" height="21" rx="7" fill="url(#gDay)"/><path d="M10 4.5v4M22 4.5v4M5 13h22" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="19" r="1.6" fill="#fff"/><circle cx="16.5" cy="19" r="1.6" fill="#fff"/><circle cx="21" cy="19" r="1.6" fill="#fff"/></svg>',
    month: '<svg class="nav-ico" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="gMonth" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#f7e7c3"/><stop offset="1" stop-color="#c9a24a"/></linearGradient></defs><rect x="5" y="5" width="22" height="22" rx="7" fill="url(#gMonth)"/><path d="M11 5v5M21 5v5M5 13h22" stroke="#fff" stroke-width="2" stroke-linecap="round"/><rect x="10" y="16" width="4" height="4" rx="1" fill="#fff"/><rect x="16" y="16" width="4" height="4" rx="1" fill="#fff"/><rect x="10" y="22" width="4" height="3.5" rx="1" fill="#fff" opacity=".85"/></svg>',
    map: '<svg class="nav-ico" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="gMap" x1="6" y1="4" x2="26" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#c8efe0"/><stop offset="1" stop-color="#3f9d82"/></linearGradient></defs><path d="M16 4.5c5.2 0 9.5 4 9.5 9.2 0 6.6-9.5 14-9.5 14S6.5 20.3 6.5 13.7C6.5 8.5 10.8 4.5 16 4.5z" fill="url(#gMap)"/><circle cx="16" cy="13.4" r="3.2" fill="#fff"/></svg>',
    notes: '<svg class="nav-ico" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="gNotes" x1="6" y1="4" x2="24" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#e4d9ff"/><stop offset="1" stop-color="#7b6bb8"/></linearGradient></defs><path d="M9 5.5h11l6 6V26a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V8.5a3 3 0 0 1 3-3z" fill="url(#gNotes)"/><path d="M20 5.5V12h6" fill="#fff" opacity=".55"/><path d="M11 17h10M11 21.5h7" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
    activity: '<svg class="nav-ico" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="gAct" x1="4" y1="6" x2="28" y2="26" gradientUnits="userSpaceOnUse"><stop stop-color="#ffd6c8"/><stop offset="1" stop-color="#e08a68"/></linearGradient></defs><rect x="4" y="6" width="24" height="20" rx="7" fill="url(#gAct)"/><path d="M7.5 20l4.2-6.2 3.4 4.4 4-7.2 5.4 9" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    set: '<svg class="nav-ico" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="gSet" x1="6" y1="6" x2="26" y2="26" gradientUnits="userSpaceOnUse"><stop stop-color="#d9dcf4"/><stop offset="1" stop-color="#6d74c7"/></linearGradient></defs><path d="M16 6.2l1.7 2.4 2.8-.6 1 2.7 2.7 1-.6 2.8 2.4 1.7-2.4 1.7.6 2.8-2.7 1-1 2.7-2.8-.6L16 25.8l-1.7-2.4-2.8.6-1-2.7-2.7-1 .6-2.8L6.2 16l2.4-1.7-.6-2.8 2.7-1 1-2.7 2.8.6L16 6.2z" fill="url(#gSet)"/><circle cx="16" cy="16" r="4" fill="#fff"/></svg>',
  };
  return icons[name] || "";
}

function screenTimeLabel(status) {
  const auth = status?.authorization || "unavailable";
  if (auth === "authorized") return "Activity Access is on";
  if (auth === "denied") return "Activity unavailable";
  if (auth === "notDetermined") return "Not enabled yet";
  return "Activity unavailable";
}

function describeActivityEnable(res, st) {
  if (st?.authorization === "authorized") {
    return res?.fallback === "individual"
      ? "Activity is on for this iPhone. Open Activity and tap Choose Apps."
      : "Activity enabled. Open the Activity tab to choose apps.";
  }
  if (isParent()) {
    return "Kash’s report uses Anika’s iPhone. Enable Activity there first.";
  }
  if (res?.reason === "requires-ios-26" || st?.reason === "requires-ios-26") {
    return "Activity needs iPhone with iOS 26.";
  }
  if (st?.authorization === "denied") {
    return "Activity was denied. Settings → Screen Time, or delete and reinstall Smart Routine.";
  }
  const detail = res?.error || st?.error;
  if (detail) return `Activity was not enabled: ${detail}`;
  return "Activity was not enabled. Allow Apple’s permission sheet. A new iPhone with an adult Apple ID uses this iPhone’s own Screen Time, not a Family Sharing child account.";
}

function activityIcon(name) {
  if (name === "phone") {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="9" y="3" width="14" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M13 7h6M14 25h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  if (name === "apps") {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="2.5" fill="currentColor"/><rect x="18" y="5" width="9" height="9" rx="2.5" fill="currentColor" opacity=".7"/><rect x="5" y="18" width="9" height="9" rx="2.5" fill="currentColor" opacity=".7"/><rect x="18" y="18" width="9" height="9" rx="2.5" fill="currentColor"/></svg>`;
  }
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 22V10M16 22V6M24 22v-7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
}

function activityView() {
  const st = ui.screenTime || { authorization: "unavailable", supported: false };
  const ready = Boolean(st.supported && st.authorization === "authorized");
  const hint = !isNative()
    ? "Open Smart Routine on iPhone, then tap Enable."
    : !st.supported
      ? "Needs iPhone with iOS 26."
      : st.authorization !== "authorized"
        ? "Tap Enable, then Allow on Apple’s sheet."
        : "Choose the apps you want on this report.";
  return `<section class="block activity-page">
      <div class="activity-hero">
        <div class="activity-orb">${activityIcon("chart")}</div>
        <div>
          <p class="eyebrow">Activity</p>
          <h2 class="block-title">Screen Time</h2>
          <p class="lede">See which apps are open on this iPhone.</p>
        </div>
      </div>
      <div class="activity-status ${ready ? "on" : ""}">
        <span class="activity-dot"></span>
        <div>
          <b>${escapeHtml(screenTimeLabel(st))}</b>
          <p class="muted">${escapeHtml(hint)}</p>
        </div>
      </div>
      ${ui.activityMsg ? `<p class="muted">${escapeHtml(ui.activityMsg)}</p>` : ""}
      <div class="activity-actions">
        <button type="button" class="activity-card" id="enableAppActivity">
          <span class="activity-ico">${activityIcon("phone")}</span>
          <span><b>Enable</b><em>Allow on this iPhone</em></span>
        </button>
        <button type="button" class="activity-card" id="chooseApps" ${ready ? "" : "disabled"}>
          <span class="activity-ico">${activityIcon("apps")}</span>
          <span><b>Choose apps</b><em>Pick what to show</em></span>
        </button>
      </div>
      <div class="purpose activity-range" role="group" aria-label="Activity range">
        <button type="button" class="chip ${ui.activityRange === "today" ? "on" : ""}" data-activity-range="today">Today</button>
        <button type="button" class="chip ${ui.activityRange === "week" ? "on" : ""}" data-activity-range="week">Last 7 days</button>
      </div>
      <div id="activityReportHost" class="activity-report-host" hidden></div>
    </section>`;
}

function viewBody() {
  if (ui.view === "month") return monthView();
  if (ui.view === "map") {
    return `${memberEnableLocationHtml()}${mapViewHtml(state, ui, { escapeHtml, toLocalInput })}`;
  }
  if (ui.view === "notes") return notesView();
  if (ui.view === "activity") return activityView();
  if (ui.view === "settings") return settingsView();
  return dayView();
}

function renderParent() {
  const view = ui.view === "settings" ? "settings" : "map";
  ui.view = view;
  const body =
    view === "settings"
      ? parentSettingsHtml(ui.familyMe, ui.familyLoc, escapeHtml, ui.familyMsg, ui.passwordMsg)
      : parentMapHtml(ui.familyLoc, escapeHtml);
  root.innerHTML = `${body}${parentNavHtml(view, navIcon)}`;
  bindParent();
}

function beforeSleepNotesHtml() {
  if (!sleepQuestionOpen()) return "";
  const date = isoDate(new Date());
  const log = (state.dayChecks || {})[date] || {};
  return `<div class="before-sleep-note">
    <p class="eyebrow">10 minutes before sleep</p>
    <h3 class="subh">Tonight</h3>
    <label class="check-opt"><input type="checkbox" data-daycheck="calledFather" data-check-date="${date}" ${log.calledFather ? "checked" : ""}>
      <span>Called Dad today</span></label>
    <label class="check-opt"><input type="checkbox" data-daycheck="prayed" data-check-date="${date}" ${log.prayed ? "checked" : ""}>
      <span>Offered prayer today</span></label>
  </div>`;
}

function dayView() {
  const ev = eventsOn(ui.selected);
  if (!ev.length) {
    return `<section class="block day-board">
      <p class="eyebrow">Today</p>
      <h2 class="block-title">No plan yet</h2>
      <p class="lede">Tap Add event. A class rings when it starts, and earlier if the walk is slow. Sleep ends with a wake-up alarm.</p>
      <div class="sheet-actions">
        <button class="btn primary" id="addEvent">Add event</button>
      </div>
    </section>`;
  }
  return `<section class="block day-board">
      <p class="eyebrow">Timeline</p>
      <h2 class="block-title">${escapeHtml(heading())}</h2>
      <p class="lede">Tap a card to edit. Class alarms and the wake-up alarm still ring when the phone is on silent.</p>
      <div class="timeline">${ev.map(cardHtml).join("")}</div>
      <div class="sheet-actions">
        <button class="btn" id="addEvent">Add event</button>
      </div>
    </section>`;
}

function dadCallBtn(e) {
  if (!needsDadCall(e)) return "";
  return `<a class="btn small" href="${DAD_WHATSAPP.href}" target="_blank" rel="noopener noreferrer" data-wa>Call</a>`;
}

function cardHtml(e) {
  const tone = TONE[e.category] || "personal";
  const sub = e.subtitle && !/call parents/i.test(e.subtitle) ? e.subtitle : "";
  const clipped = clipToDay(e.start, e.end, ui.selected);
  const dur = durationMin(clipped.start, clipped.end);
  return `<article class="card tone-${tone} ${e.done ? "done" : ""}" data-id="${e.id}">
    <button class="check ${e.done ? "on" : ""}" data-check="${e.id}" aria-label="Mark complete"></button>
    <div class="card-body">
      <div class="tag">${CAT[e.category] || e.category}${e.source === "user" ? " · yours" : ""}</div>
      <h3>${escapeHtml(prettyTitle(e))}</h3>
      <p>${fmtRange(clipped.start, clipped.end)}${sub ? " · " + escapeHtml(sub) : ""}${
        e.alarm !== false ? " · alarm" : ""
      }</p>
      ${prettyNotes(e) ? `<p>${escapeHtml(prettyNotes(e))}</p>` : ""}
      <div class="card-actions">
        <button type="button" class="btn small" data-edit="${e.id}">Edit</button>
        <button type="button" class="btn small danger" data-remove="${e.id}">Remove</button>
        ${dadCallBtn(e)}
      </div>
    </div>
    <div class="when"><span>${fmtTime(clipped.start)}</span><em>${prettyDur(dur)}</em></div>
  </article>`;
}

function monthView() {
  const [y, m] = ui.monthCursor.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const start = startOfWeek(isoDate(first));
  const end = addDays(start, 41);
  const days = eachDate(start, end);
  const hd = WEEK_HD;
  return `<section class="block">
    <div class="row month-nav">
      <button class="btn small" id="prevM">Prev</button>
      <strong>${MONTHS[first.getMonth()]} ${first.getFullYear()}</strong>
      <button class="btn small" id="nextM">Next</button>
    </div>
    <div class="month">${hd.map((h) => `<div class="hd">${h}</div>`).join("")}${days
      .map((d) => {
        const out = d.slice(0, 7) !== ui.monthCursor;
        const count = eventsOn(d).filter((e) => e.kind === "class").length;
        return `<button class="cell ${out ? "out" : ""}" data-day="${d}">
          <div class="num">${Number(d.slice(8))}</div>
          <span class="shift">${count ? `${count} class` : ""}</span>
        </button>`;
      })
      .join("")}</div>
  </section>`;
}

function notesView() {
  const notes = (state.notes || []).filter((n) => !n.converted);
  return `<section class="block notes-page">
      <p class="eyebrow">Notepad</p>
      <h2 class="block-title">Notes</h2>
      <p class="lede">Save a note first. Turn it into an event only when it belongs on the day.</p>
      ${beforeSleepNotesHtml()}
      <div class="note-composer">
        <label class="field"><span>Write a note</span>
          <textarea id="newNote" rows="6" placeholder="Something to remember…"></textarea>
        </label>
        <button class="btn primary" id="saveNote">Save note</button>
      </div>
      <div class="note-saved-head">
        <h3 class="subh">Saved</h3>
        <span class="muted">${notes.length}</span>
      </div>
      ${
        notes.length
          ? `<div class="note-list">${notes
              .map((n) => {
                const onDay = Boolean(n.eventId);
                return `<article class="note-card">
              <div class="note-card-top">
                <time>${escapeHtml(noteWhen(n.createdAt))}</time>
                ${onDay ? `<span class="note-pill">On the day</span>` : ""}
              </div>
              <p>${escapeHtml(n.text)}</p>
              <div class="card-actions">
                ${
                  onDay
                    ? ""
                    : `<button class="btn small primary" data-to-event="${n.id}">Turn into event</button>`
                }
                <button class="btn small danger" data-del-note="${n.id}">Delete</button>
              </div>
            </article>`;
              })
              .join("")}</div>`
          : `<div class="empty note-empty">Saved notes show up here.</div>`
      }
    </section>`;
}

function challengeHtml() {
  const c = ui.challenge;
  const digits = ui.challengeInput || "";
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "Go"];
  return `<div class="wake-challenge" role="dialog" aria-modal="true" aria-label="Solve to stop the alarm">
    <p class="eyebrow">Solve to Stop</p>
    <h1>${escapeHtml(c.question || "…")}</h1>
    <p class="muted">Question ${c.questionNumber || 1} of ${c.questionCount || 1}</p>
    <div class="wake-answer" aria-live="polite">${escapeHtml(digits) || " "}</div>
    ${ui.challengeError ? `<p class="wake-error">${escapeHtml(ui.challengeError)}</p>` : ""}
    <div class="wake-keypad">${keys
      .map((k) => `<button type="button" class="wake-key" data-key="${escapeAttr(k)}">${k}</button>`)
      .join("")}</div>
    <p class="muted small">${
      alarmKitCopyState() === "checking"
        ? "Checking AlarmKit…"
        : alarmKitMathLive()
        ? "Slide to Stop is Apple’s button and cannot be hidden. It only silences this ring — the alarm comes back in a few seconds until you finish the math."
        : alarmKitCopyState() === "supported"
        ? "AlarmKit is available. Enable iPhone alarms so Solve to Stop can run."
        : "This notification does not have AlarmKit’s Solve to Stop button. Opening the app shows the math challenge. Backup notifications are ordinary alerts — Silent Mode and Focus bypass is not guaranteed."
    }</p>
  </div>`;
}

function bindChallenge() {
  root.querySelectorAll("[data-key]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
      if (key === "⌫") {
        ui.challengeInput = String(ui.challengeInput || "").slice(0, -1);
        ui.challengeError = "";
        render();
        return;
      }
      if (key === "Go") {
        await submitChallenge();
        return;
      }
      if ((ui.challengeInput || "").length >= 6) return;
      ui.challengeInput = `${ui.challengeInput || ""}${key}`;
      ui.challengeError = "";
      render();
    });
  });
}

async function submitChallenge() {
  const answer = ui.challengeInput;
  const alarmId = ui.challenge?.alarmId;
  const res = await submitWakeChallenge({ alarmId, answer });
  if (!res?.correct) {
    haptic("warning");
    ui.challengeError = "Not quite — try again.";
    ui.challengeInput = "";
    if (res?.nextQuestion) ui.challenge.question = res.nextQuestion;
    ui.challenge.attempts = res?.attempts ?? (ui.challenge.attempts || 0) + 1;
    render();
    return;
  }
  if (!res.complete) {
    haptic("light");
    ui.challenge.question = res.nextQuestion;
    ui.challenge.questionNumber = (ui.challenge.questionNumber || 1) + 1;
    ui.challenge.attempts = res.attempts;
    ui.challengeInput = "";
    ui.challengeError = "";
    render();
    return;
  }
  haptic("success");
  const eventId = String(alarmId || "").split(":")[0];
  const ev = state.events.find((e) => e.id === eventId);
  if (ev) ev.verifiedAt = new Date().toISOString();
  ui.challenge = null;
  ui.challengeInput = "";
  ui.challengeError = "";
  if (!ui.familyMe?.ok) {
    try {
      const me = await familyMe();
      ui.familyMe = me.ok ? me : null;
    } catch {
      /* session missing — login gate is correct */
    }
  }
  await save();
  await syncAll(state, "wake-verified");
  render();
}

async function refreshChallenge() {
  try {
    const { pending } = await prepareForegroundSync(state, "url-open");
    if (pending?.active) {
      ui.challenge = pending;
      ui.challengeInput = ui.challengeInput || "";
      return true;
    }
  } catch {
    /* native plugin absent */
  }
  ui.challenge = null;
  return false;
}

function alarmKitCopyState() {
  const d = ui.diag;
  const probe = ui.alarmKitSupport;
  const supported = d?.alarmKitSupported ?? probe?.supported;
  const auth = d?.alarmAuthorization ?? probe?.authorization;
  const loaded = Boolean(d) || probe?.loaded === true;
  if (!isNative()) return "unsupported";
  if (!loaded) return "checking";
  if (supported === true && auth === "authorized") return "live";
  if (supported === true) return "supported";
  if (supported === false) return "unsupported";
  return "checking";
}

function alarmKitMathLive() {
  return alarmKitCopyState() === "live";
}

function testAlarmArgs(extra = {}) {
  const wv = wakeVerificationSettings(state.settings);
  return {
    ...extra,
    protected: wv.enabled,
    difficulty: wv.difficulty,
    questionCount: wv.questionCount,
  };
}

function diagRow(label, value) {
  return `<div class="diag-row">
    <span class="muted">${escapeHtml(label)}</span>
    <span>${escapeHtml(String(value ?? "—"))}</span>
  </div>`;
}

function diagnosticsHtml() {
  const d = ui.diag;
  const native = runtimeMode().startsWith("native");
  const rows = d
    ? [
        ["Runtime mode", d.runtimeMode],
        ["iOS version", d.iosVersion],
        ["AlarmKit supported", d.alarmKitSupported ? "yes" : `no${d.alarmKitReason ? ` (${d.alarmKitReason})` : ""}`],
        ["Alarm authorization", d.alarmAuthorization],
        ["Notification authorization", d.notificationAuthorization],
        ["Screen Time authorization", d.screenTimeAuthorization],
        ["Scheduled primary alarms", `${d.scheduledPrimaryAlarms ?? d.scheduledAlarms} (planned ${d.plannedAlarms})`],
        ["Backup alarms", `${d.backupAlarmCount ?? 0} (planned ${d.plannedBackupAlarms ?? 0})`],
        [
          "Pending wake challenge",
          d.pendingWakeChallenge?.active
            ? `yes · ${d.pendingWakeChallenge.alarmId} · ${d.pendingWakeChallenge.questionNumber}/${d.pendingWakeChallenge.questionCount}`
            : "no",
        ],
        [
          "Next protected wake",
          d.nextProtectedWake ? `${d.nextProtectedWake.title} · ${fmtTime(d.nextProtectedWake.at)}` : "none",
        ],
        ["Fallback reason", d.fallbackReason || "none"],
        [
          "Alarm coverage",
          d.alarmKitUncertain
            ? "local notifications (AlarmKit query failed — ownership uncertain)"
            : d.alarmCoverage || "—",
        ],
        [
          "Maximum-limit errors",
          d.maximumLimit ? `${d.maximumLimit.capped} capped` : "none",
        ],
        ["Pending notifications", `${d.pendingNotifications} (planned ${d.plannedNotifications})`],
        ["Delivery route", d.deliveryRoute + (d.deliveryDetail ? ` (${d.deliveryDetail})` : "")],
        ["Time zone", d.timeZone],
        ["Next alarm", d.nextAlarm ? `${d.nextAlarm.title} · ${fmtTime(d.nextAlarm.at)}` : "none"],
        [
          "Next notification",
          d.nextNotification ? `${d.nextNotification.title} · ${fmtTime(d.nextNotification.at)}` : "none",
        ],
        [
          "Web Push",
          d.webPush?.supported
            ? `${d.webPush.subscribed ? "subscribed" : "not subscribed"}${
                d.webPush.devices != null ? ` · ${d.webPush.devices} device(s)` : ""
              }`
            : "not applicable",
        ],
        [
          "Last sync",
          d.lastSync ? `${d.lastSync.reason} · ${d.lastSync.ok ? "ok" : "failed"} · ${fmtTime(d.lastSync.at)}` : "none",
        ],
        ["Current sync error", d.currentSyncError || "none"],
        [
          "Last error (historical)",
          d.lastError ? `${d.lastError.scope}: ${d.lastError.message} · ${fmtTime(d.lastError.at)}` : "none",
        ],
        [
          "Last native error (historical)",
          d.lastNativeError
            ? `${d.lastNativeError.scope}: ${d.lastNativeError.message} · ${fmtTime(d.lastNativeError.at)}`
            : "none",
        ],
        [
          "AlarmKit sync detail",
          d.lastSync?.ok ? "none" : d.alarmSyncDetail
            ? [
                d.alarmSyncDetail.error,
                (d.alarmSyncDetail.failed || []).length ? `failed ${d.alarmSyncDetail.failed.length}` : null,
                (d.alarmSyncDetail.capped || []).length ? `capped ${d.alarmSyncDetail.capped.length}` : null,
                d.alarmSyncDetail.maximumLimitReached ? "maximumLimitReached" : null,
              ]
                .filter(Boolean)
                .join(" · ") || "none"
            : "none",
        ],
      ]
        .map(([k, v]) => diagRow(k, v))
        .join("")
    : `<p class="muted">Tap Refresh to read the current alarm and notification state.</p>`;
  const activityDiag = ui.screenTime?.error
    ? `<p class="muted">Activity plugin: ${escapeHtml(ui.screenTime.error)}</p>`
    : "";

  return `<section class="block">
    <p class="eyebrow">Support</p>
    <h2 class="block-title">Diagnostics</h2>
    <p class="lede">Alarm and notification state on this device.</p>
    ${rows}
    ${activityDiag}
    ${ui.diagMsg ? `<p class="muted">${escapeHtml(ui.diagMsg)}</p>` : ""}
    <div class="map-tools diag-actions">
      <button type="button" class="btn small" id="diagRefresh">Refresh</button>
      <button type="button" class="btn small" id="diagNotify">Enable notifications</button>
      ${native ? `<button type="button" class="btn small" id="diagAlarms">Enable iPhone alarms</button>` : ""}
      ${native ? `<button type="button" class="btn small" id="diagScreenTime">Enable Activity</button>` : ""}
      <button type="button" class="btn small" id="diagTestNotify">Test notification (2 min)</button>
      <button type="button" class="btn small ghost" id="diagCancelNotify">Cancel test notification</button>
      ${native ? `<button type="button" class="btn small" id="diagTestAlarm">Test alarm (2 min)</button>` : ""}
      ${native ? `<button type="button" class="btn small ghost" id="diagCancelAlarm">Cancel test alarm</button>` : ""}
      <button type="button" class="btn small" id="diagResync">Resynchronize</button>
    </div>
  </section>`;
}

function settingsView() {
  return `${changePasswordHtml(escapeHtml, ui.passwordMsg)}
    <section class="block">
      <p class="eyebrow">Alarms</p>
      <h2 class="block-title">Notifications</h2>
      <p class="lede">Alarms stay on. A class rings at the start, and the walk to school rings earlier when the road is slow. Wake-up starts when sleep ends. It rings 5 times, 30 seconds apart, including when the phone is on silent. Slide to Stop or the side button only quiets the ring that is playing. Open the lock screen and the quiz is there. Solve to Stop or Off opens the quiz. The alarm stops after a correct answer. On phones without AlarmKit, the notification does not have AlarmKit’s Solve to Stop button. Silent Mode and Focus bypass is not guaranteed.</p>
      <div class="note-card notify-status">
        <p><b>Notifications</b><br><span class="muted">${escapeHtml(alarmsStatusLabel(isNative() ? ui.notificationAuth : null))}</span></p>
      </div>
      ${
        isNative()
          ? ui.notificationAuth !== "granted" || ui.alarmKitSupport?.authorization !== "authorized"
            ? `<div class="sheet-actions"><button type="button" class="btn primary" id="enableAlarms">Enable alarms</button></div>`
            : ""
          : needsAlarmSetup() || notificationPermission() === "denied"
            ? `<div class="sheet-actions"><button type="button" class="btn primary" id="enableAlarms">Enable alarms</button></div>`
            : ""
      }
      ${
        isNative()
          ? `<div class="sheet-actions">
      <button type="button" class="btn" id="testAlarmSoon">Test alarm in 5 seconds</button>
      ${ui.testAlarmMsg ? `<p class="muted">${escapeHtml(ui.testAlarmMsg)}</p>` : `<p class="muted">${
        wakeVerificationSettings(state.settings).enabled
          ? "Lock the phone. When it rings, tap Solve to Stop or Off — the math quiz opens. A correct answer turns the alarm off."
          : "Schedules a real AlarmKit alarm — lock the phone and wait."
      }</p>`}
    </div>`
          : ""
      }
    </section>
    ${memberSignOutHtml()}
    ${diagnosticsHtml()}`;
}

function sheetHtml() {
  const sh = ui.sheet;
  if (sh.type === "event") {
    const e = sh.event;
    const start = fromISO(e.start);
    const dur = durationMin(e.start, e.end);
    const editing = Boolean(e.id);
    return `<div class="sheet" id="sheet"><div class="panel">
      <h2>${editing ? "Edit block" : sh.noteId ? "Turn into event" : "New event"}</h2>
      <label class="field"><span>Title</span>
        <input id="fTitle" value="${escapeAttr(e.title || "")}" placeholder="Gym, clinic, dinner…" autocomplete="off">
      </label>
      <div class="sheet-grid">
        <label class="field"><span>Date</span>
          <input id="fDate" type="date" value="${toLocalDateInput(start)}">
        </label>
        <label class="field"><span>Time</span>
          <input id="fTime" type="time" value="${toLocalTimeInput(start)}">
        </label>
        <label class="field"><span>Duration</span>
          <span class="with-unit"><input id="fDur" type="number" min="5" step="5" value="${dur}"><em>min</em></span>
        </label>
        <label class="field"><span>Type</span>
          <select id="fCat">${eventTypeOptions(e.category)
            .map(([k, label]) => `<option value="${k}" ${e.category === k ? "selected" : ""}>${label}</option>`)
            .join("")}</select>
        </label>
      </div>
      <div class="sheet-checks">
        <label class="check-opt"><input type="checkbox" id="fRecur" ${e.recurring ? "checked" : ""}> Weekly</label>
        ${
          e.source === "auto"
            ? `<label class="check-opt span-2"><input type="checkbox" id="fFuture"> Also change future days</label>`
            : ""
        }
      </div>
      <div class="sheet-actions">
        <button class="btn primary" id="saveEv">Save</button>
        ${editing ? `<button class="btn danger" id="delEv">Remove</button>` : ""}
        <button class="btn ghost" id="closeSheet">Close</button>
      </div>
    </div></div>`;
  }
  if (sh.type === "place") return placeSheetHtml(sh, { escapeHtml, escapeAttr });
  return "";
}

function bindFamilyLogin() {
  root.querySelector("#familyLoginForm")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const username = root.querySelector("#loginUser")?.value || "";
    const password = root.querySelector("#loginPass")?.value || "";
    const out = await familySignIn(username, password);
    ui.familyMsg = out.ok ? "" : "Could not sign in";
    ui.familyMe = out.ok ? await familyMe() : null;
    if (isParent()) {
      ui.view = "map";
      ui.watchedMember = "anika";
      if (isNative()) void registerFamilyPush();
    }
    if (isMember()) {
      await loadMemberRoutine();
      familyLocationStatus()
        .then((st) => {
          ui.familyLocStatus = st;
        })
        .catch(() => {});
      void refreshSchoolWalk().then(() => syncAll(state, "school-walk")).catch(() => {});
    }
    render();
    if (out.ok) void pulsePresence();
    if (isParent()) {
      familyGetLocation(watchedMember())
        .then((loc) => {
          ui.familyLoc = loc;
          render();
        })
        .catch(() => {});
    }
  });
}

function bindMemberFamily() {
  root.querySelector("#locWhenInUse")?.addEventListener("click", async () => {
    ui.familyLocStatus = await requestWhenInUseLocation();
    const auth = ui.familyLocStatus?.authorization;
    if (ui.familyLocStatus?.ok || auth === "whenInUse" || auth === "always") {
      if (auth === "whenInUse") {
        const always = await requestAlwaysLocation();
        if (always?.authorization) ui.familyLocStatus = always;
      }
      await startFamilyLocationSharing();
    }
    await refreshFamily();
    render();
  });
  root.querySelector("#familySignOutMember")?.addEventListener("click", async () => {
    await stopFamilyLocationSharing({ paused: true });
    await familyLogout();
    ui.familyMe = null;
    ui.view = "today";
    resetRoutineMemory();
    render();
  });
}

function bindMemberSwitch() {
  const closeAll = () => {
    root.querySelectorAll(".member-switch").forEach((p) => p.classList.remove("open"));
    root.querySelectorAll(".member-switch .pick-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
  };
  root.querySelectorAll(".member-switch").forEach((pick) => {
    const btn = pick.querySelector(".pick-btn");
    btn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const willOpen = !pick.classList.contains("open");
      closeAll();
      if (willOpen) {
        pick.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
      }
    });
    pick.querySelectorAll("[data-member]").forEach((opt) => {
      opt.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = opt.dataset.member;
        closeAll();
        if (!next || next === watchedMember()) return;
        ui.watchedMember = next;
        ui.familyLoc = await familyGetLocation(next);
        render();
      });
    });
  });
}

function bindParent() {
  bindMemberSwitch();
  root.querySelectorAll("[data-view]").forEach((el) =>
    el.addEventListener("click", () => {
      const next = el.dataset.view === "settings" ? "settings" : "map";
      if (ui.view === next) return;
      ui.view = next;
      render();
      familyGetLocation(watchedMember())
        .then((loc) => {
          ui.familyLoc = loc;
          render();
        })
        .catch(() => {});
    })
  );
  root.querySelector("#homeAllDay")?.addEventListener("change", (ev) => {
    const on = ev.target.checked;
    root.querySelector("#homeStart")?.toggleAttribute("disabled", on);
    root.querySelector("#homeEnd")?.toggleAttribute("disabled", on);
  });
  root.querySelector("#saveHome")?.addEventListener("click", async () => {
    const allDay = root.querySelector("#homeAllDay")?.checked === true;
    const out = await familySetHome({
      member: watchedMember(),
      lat: Number(root.querySelector("#homeLat")?.value),
      lng: Number(root.querySelector("#homeLng")?.value),
      radiusM: Number(root.querySelector("#homeRadius")?.value),
      startMin: allDay ? 0 : timeInputToMinutes(root.querySelector("#homeStart")?.value, 0),
      endMin: allDay ? 0 : timeInputToMinutes(root.querySelector("#homeEnd")?.value, 300),
    });
    ui.familyMsg = out.ok
      ? out.alert === "away"
        ? "Location pin saved · Away alert sent"
        : out.alert === "returned"
          ? "Location pin saved · Returned alert sent"
          : "Location pin saved"
      : out.error || "Could not save the location pin";
    ui.familyLoc = await familyGetLocation(watchedMember());
    render();
  });
  root.querySelector("#deleteHistory")?.addEventListener("click", async () => {
    await familyDeleteHistory(watchedMember());
    ui.familyLoc = await familyGetLocation(watchedMember());
    ui.familyMsg = "Location history deleted";
    render();
  });
  root.querySelector("#familySignOut")?.addEventListener("click", async () => {
    await familyLogout();
    ui.familyMe = null;
    ui.watchedMember = "anika";
    ui.view = "today";
    resetRoutineMemory();
    render();
  });
  bindChangePassword();
  destroyMap();
  if (ui.view === "map") paintFamilyMap(ui.familyLoc);
  else destroyFamilyMap();
  void syncActivityReport();
}

function bind() {
  root.querySelector("#gen")?.addEventListener("click", generate);
  root.querySelector("#todayBtn")?.addEventListener("click", () => {
    ui.selected = isoDate(new Date());
    ui.view = "today";
    render();
  });
  root.querySelectorAll("[data-day]").forEach((el) =>
    el.addEventListener("click", () => {
      ui.selected = el.dataset.day;
      ui.view = "today";
      render();
    })
  );
  root.querySelectorAll("[data-daycheck]").forEach((el) =>
    el.addEventListener("change", async () => {
      const date = el.dataset.checkDate || isoDate(new Date());
      state.dayChecks = state.dayChecks || {};
      const log = state.dayChecks[date] || {};
      log[el.dataset.daycheck] = el.checked;
      state.dayChecks[date] = log;
      await save();
    })
  );
  bindChangePassword();
  root.querySelectorAll("[data-view]").forEach((el) =>
    el.addEventListener("click", () => {
      if (ui.view === el.dataset.view) return;
      ui.view = el.dataset.view;
      render();
    })
  );
  root.querySelectorAll("[data-check]").forEach((el) =>
    el.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const e = state.events.find((x) => x.id === el.dataset.check);
      if (!e) return;
      e.done = !e.done;
      haptic(e.done ? "success" : "light");
      await save();
      await syncAll(state, e.done ? "event-completed" : "event-uncompleted");
      render();
    })
  );
  root.querySelectorAll("[data-edit]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openEvent(el.dataset.edit);
    })
  );
  root.querySelectorAll("[data-remove]").forEach((el) =>
    el.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await removeEvent(el.dataset.remove);
    })
  );
  root.querySelectorAll(".card").forEach((el) =>
    el.addEventListener("click", (ev) => {
      if (!el.dataset.id) return;
      if (ev.target.closest("[data-check], [data-edit], [data-remove], [data-wa]")) return;
      openEvent(el.dataset.id);
    })
  );
  root.querySelector("#addEvent")?.addEventListener("click", () => {
    const start = new Date(ui.selected + "T08:00:00");
    ui.sheet = {
      type: "event",
      event: {
        title: "",
        category: "class",
        kind: "class",
        start: start.toISOString(),
        end: new Date(start.getTime() + 50 * 60000).toISOString(),
        date: ui.selected,
        alarm: true,
        source: "user",
        recurring: null,
      },
    };
    render();
  });
  root.querySelector("#saveNote")?.addEventListener("click", async () => {
    const text = root.querySelector("#newNote").value.trim();
    if (!text) return;
    state.notes.unshift({ id: uid("n"), text, createdAt: new Date().toISOString(), converted: false });
    haptic("success");
    await save();
    await syncAll(state, "note-saved");
    render();
  });
  root.querySelectorAll("[data-del-note]").forEach((el) =>
    el.addEventListener("click", async () => {
      state.notes = state.notes.filter((n) => n.id !== el.dataset.delNote);
      await save();
      await syncAll(state, "note-deleted");
      render();
    })
  );
  root.querySelectorAll("[data-to-event]").forEach((el) =>
    el.addEventListener("click", () => {
      const note = state.notes.find((n) => n.id === el.dataset.toEvent);
      if (!note) return;
      const start = new Date(`${ui.selected}T12:00:00`);
      ui.sheet = {
        type: "event",
        noteId: note.id,
        event: {
          title: note.text.split("\n")[0].slice(0, 80),
          notes: note.text,
          category: "personal",
          kind: "personal",
          start: start.toISOString(),
          end: new Date(start.getTime() + 60 * 60000).toISOString(),
          date: ui.selected,
          alarm: true,
          source: "user",
          recurring: null,
        },
      };
      render();
    })
  );
  root.querySelector("#enableAlarms")?.addEventListener("click", async () => {
    if (isNative()) {
      const notes = await enableNotifications();
      const alarms = await enableAlarms();
      const probe = await probeNativePermissions();
      ui.notificationAuth = probe.notifications;
      ui.alarmKitSupport = nativeSupportFromProbe(probe);
      if (notes.ok || alarms.ok) await syncAll(state, "notifications-enabled");
      ui.testAlarmMsg = [notes.ok ? null : notes.detail, alarms.ok ? null : alarms.detail].filter(Boolean).join(" ") || "";
    } else {
      await enableAlarmsFromBanner();
      await syncAll(state, "notifications-enabled");
    }
    render();
  });
  root.querySelector("#testAlarmSoon")?.addEventListener("click", async () => {
    haptic("medium");
    ui.testAlarmMsg = "Scheduling…";
    render();
    const gate = await probeTestAlarmAuthorization();
    ui.notificationAuth = gate.probe.notifications;
    ui.alarmKitSupport = nativeSupportFromProbe(gate.probe);
    if (!gate.ok) {
      ui.testAlarmMsg = gate.detail;
      render();
      return;
    }
    const res = await scheduleTestAlarm(testAlarmArgs({ seconds: 5 }));
    ui.testAlarmMsg = res.ok
      ? wakeVerificationSettings(state.settings).enabled
        ? "Alarm set — lock the phone. Tap Solve to Stop or Off for the math quiz."
        : "Alarm set — lock the phone and wait 5 seconds."
      : res.detail || "Could not schedule the test alarm.";
    render();
  });
  bindDiagnostics();
  root.querySelector("#prevM")?.addEventListener("click", () => {
    const [y, m] = ui.monthCursor.split("-").map(Number);
    const d = new Date(y, m - 2, 1);
    ui.monthCursor = isoDate(d).slice(0, 7);
    render();
  });
  root.querySelector("#nextM")?.addEventListener("click", () => {
    const [y, m] = ui.monthCursor.split("-").map(Number);
    const d = new Date(y, m, 1);
    ui.monthCursor = isoDate(d).slice(0, 7);
    render();
  });
  bindSheet();
  if (ui.view === "map") {
    bindMap(root, {
      state,
      ui,
      save,
      syncAll,
      haptic,
      render,
      uid,
      isoDate,
      toLocalInput,
      escapeHtml,
      escapeAttr,
    });
  } else {
    destroyMap();
    destroyFamilyMap();
  }
  bindActivity();
  bindMemberFamily();
  void syncActivityReport();
  if (ui.sheet?.type === "place") bindPlaceSheet(root, { haptic });
  else destroyPlaceMap();
}

function bindActivity() {
  if (isParent() || ui.view !== "activity") return;
  if (!ui.screenTime) {
    screenTimeStatus().then((status) => {
      if (ui.view !== "activity") return;
      ui.screenTime = status;
      render();
    });
  }
  root.querySelector("#enableAppActivity")?.addEventListener("click", async () => {
    const res = await enableScreenTime({ member: "child" });
    ui.screenTime = {
      ...(await screenTimeStatus()),
      error: res.error,
      reason: res.reason,
      fallback: res.fallback,
    };
    ui.activityMsg = describeActivityEnable(res, ui.screenTime);
    haptic(ui.screenTime.authorization === "authorized" ? "success" : "light");
    render();
  });
  root.querySelector("#chooseApps")?.addEventListener("click", async () => {
    await chooseScreenTimeApps();
    ui.screenTime = await screenTimeStatus();
    render();
  });
  root.querySelectorAll("[data-activity-range]").forEach((el) =>
    el.addEventListener("click", () => {
      ui.activityRange = el.dataset.activityRange === "week" ? "week" : "today";
      render();
    })
  );
}

async function syncActivityReport() {
  const st = ui.screenTime;
  const memberView = isMember() && ui.view === "activity";
  if (!memberView) {
    await detachScreenTimeReport();
    return;
  }
  const host = document.getElementById("activityReportHost");
  const canShow = Boolean(host && st?.supported && st.authorization === "authorized");
  if (canShow) {
    host.hidden = false;
    await attachScreenTimeReport(ui.activityRange, host);
  } else {
    if (host) host.hidden = true;
    await detachScreenTimeReport();
  }
}

async function refreshDiagnostics(message = "") {
  ui.diagMsg = message;
  try {
    ui.diag = await getDiagnostics(state);
    if (isNative()) {
      ui.notificationAuth = ui.diag.notificationAuthorization;
      ui.alarmKitSupport = {
        loaded: true,
        supported: ui.diag.alarmKitSupported,
        authorization: ui.diag.alarmAuthorization,
        osVersion: ui.diag.iosVersion,
      };
    }
  } catch (err) {
    ui.diagMsg = `Could not read diagnostics: ${err?.message || err}`;
  }
  render();
}

function describe(res) {
  if (res?.ok) return res.at ? `Scheduled for ${fmtTime(res.at)}.` : "Done.";
  return res?.detail || `Failed${res?.reason ? ` (${res.reason})` : ""}.`;
}

function bindDiagnostics() {
  root.querySelector("#diagRefresh")?.addEventListener("click", () => refreshDiagnostics());
  root.querySelector("#diagNotify")?.addEventListener("click", async () => {
    const res = await enableNotifications();
    if (res.ok) await syncAll(state, "notifications-enabled");
    await refreshDiagnostics(describe(res));
  });
  root.querySelector("#diagAlarms")?.addEventListener("click", async () => {
    const res = await enableAlarms();
    if (res.ok) await syncAll(state, "alarms-authorized");
    await refreshDiagnostics(describe(res));
  });
  root.querySelector("#diagScreenTime")?.addEventListener("click", async () => {
    const res = await enableScreenTime({ member: isParent() ? "children-report" : "child" });
    ui.screenTime = {
      ...(await screenTimeStatus()),
      error: res.error,
      reason: res.reason,
      fallback: res.fallback,
    };
    await refreshDiagnostics(describeActivityEnable(res, ui.screenTime));
  });
  root.querySelector("#diagTestNotify")?.addEventListener("click", async () => {
    const res = await scheduleTestNotification(2);
    await refreshDiagnostics(describe(res));
  });
  root.querySelector("#diagCancelNotify")?.addEventListener("click", async () => {
    const res = await cancelTestNotification();
    await refreshDiagnostics(res.ok ? "Test notification cancelled." : describe(res));
  });
  root.querySelector("#diagTestAlarm")?.addEventListener("click", async () => {
    const res = await scheduleTestAlarm(testAlarmArgs({ minutes: 2 }));
    await refreshDiagnostics(describe(res));
  });
  root.querySelector("#diagCancelAlarm")?.addEventListener("click", async () => {
    const res = await cancelTestAlarm();
    await refreshDiagnostics(res.ok ? "Test alarm cancelled." : describe(res));
  });
  root.querySelector("#diagResync")?.addEventListener("click", async () => {
    const res = await syncAll(state, "manual-resync");
    if (!res.ok) {
      await refreshDiagnostics("Resynchronize failed — see Last error.");
      return;
    }
    const n = res.notifications || {};
    await refreshDiagnostics(
      n.skipped
        ? "Resynchronized. Reminders are delivered by the server on this device."
        : `Resynchronized: ${n.scheduled ?? 0} scheduled, ${n.updated ?? 0} updated, ${n.cancelled ?? 0} cancelled.`
    );
  });
}

function bindChangePassword() {
  root.querySelector("#changePasswordForm")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const currentPassword = root.querySelector("#oldPass")?.value || "";
    const newPassword = root.querySelector("#newPass")?.value || "";
    const out = await familyChangePassword(currentPassword, newPassword);
    ui.passwordMsg = out.ok
      ? "Password saved. Next time, sign in with the new one."
      : out.error === "wrong-password"
        ? "Current password is wrong."
        : out.error === "invalid-password"
          ? "New password needs at least 6 characters."
          : "Could not change the password.";
    render();
  });
}

function bindSheet() {
  root.querySelector("#closeSheet")?.addEventListener("click", () => {
    ui.sheet = null;
    render();
  });
  root.querySelector("#sheet")?.addEventListener("click", (e) => {
    if (e.target.id === "sheet") {
      ui.sheet = null;
      render();
    }
  });
  root.querySelector("#fCat")?.addEventListener("change", () => {
    if (ui.sheet?.event?.id) return;
    const dur = root.querySelector("#fDur");
    if (dur) dur.value = String(durationForCategory(root.querySelector("#fCat").value));
  });
  root.querySelector("#saveEv")?.addEventListener("click", async () => {
    const category = root.querySelector("#fCat").value;
    const kind = kindForCategory(category);
    const fallback =
      category === "commuteCall" ? "Call Dad" : category === "sleep" ? "Sleep" : category === "class" ? "Class" : "Event";
    const title = root.querySelector("#fTitle").value.trim() || fallback;
    const start = readSheetStart();
    const dur = Number(root.querySelector("#fDur").value) || durationForCategory(category);
    const recur = root.querySelector("#fRecur")?.checked;
    const future = root.querySelector("#fFuture")?.checked;
    const orig = ui.sheet.event;
    const noteId = ui.sheet.noteId;
    const patch = {
      ...orig,
      title,
      category,
      kind,
      start: start.toISOString(),
      end: new Date(start.getTime() + dur * 60000).toISOString(),
      date: isoDate(start),
      alarm: true,
      locked: orig.source === "auto",
      recurring: recur
        ? { freq: "weekly", weekdays: [start.getDay()] }
        : null,
      source: orig.source || "user",
    };
    if (!orig.id) {
      patch.id = uid("user");
      patch.source = "user";
      if (noteId) {
        const note = state.notes.find((n) => n.id === noteId);
        if (note) {
          note.eventId = patch.id;
          patch.notes = note.text;
        }
      }
      state.events.push(patch);
    } else {
      const i = state.events.findIndex((e) => e.id === orig.id);
      if (i >= 0) {
        if (patch.end !== orig.end) patch.verifiedAt = null;
        state.events[i] = { ...state.events[i], ...patch, id: orig.id };
      }
      if (future && orig.templateKey) applyFuture(orig.templateKey, dur, start);
    }
    ui.sheet = null;
    if (kind === "class") await refreshSchoolWalk();
    enforceMandatoryAlarms();
    await save();
    await syncAll(state, "event-saved");
    render();
  });
  root.querySelector("#delEv")?.addEventListener("click", async () => {
    await removeEvent(ui.sheet.event.id);
  });
  root.querySelector("#savePlace")?.addEventListener("click", async () => {
    const purpose = root.querySelector("#pPurpose").value;
    const searchQ = root.querySelector("#pSearch")?.value.trim() || "";
    const name = root.querySelector("#pName").value.trim() || searchQ;
    let address = root.querySelector("#pAddr").value.trim() || searchQ;
    const lat = Number(root.querySelector("#pLat")?.value);
    const lng = Number(root.querySelector("#pLng")?.value);
    const hasPin = Number.isFinite(lat) && Number.isFinite(lng);
    if (!name) return;
    if (!address && hasPin) address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    if (!address) return;
    const place = { id: uid("place"), purpose, name, address };
    if (hasPin) {
      place.lat = lat;
      place.lng = lng;
    } else {
      try {
        const pt = await geocode(address);
        if (pt) Object.assign(place, pt);
      } catch {
        /* route can geocode later */
      }
    }
    state.places.push(place);
    ui.travel.purpose = purpose;
    ui.travel.toId = place.id;
    ui.sheet = null;
    haptic("success");
    await save();
    render();
  });
}

function applyFuture(templateKey, durMin, start) {
  const map = {
    mcat: state.shifts[isoDate(start)] ? "mcatWorkMin" : "mcatOffMin",
    commute: "commuteMin",
    gym: "gymMin",
    laundry: "laundryMin",
    groceries: "groceriesMin",
    mealprep: "mealPrepMin",
    jk: "jkDurationMin",
    breakfast: "breakfastOffMin",
    lunch: "lunchOffMin",
    dinner: "dinnerOffMin",
    sleep: "sleepWorkMin",
    recovery: "sleepOffMin",
  };
  const key = map[templateKey];
  if (key) state.settings[key] = durMin;
  const tmin = start.getHours() * 60 + start.getMinutes();
  if (templateKey === "jk") state.settings.jkStartMin = tmin;
}

function toLocalInput(d) {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 16);
}
function toLocalDateInput(d) {
  return toLocalInput(d).slice(0, 10);
}
function toLocalTimeInput(d) {
  return toLocalInput(d).slice(11, 16);
}
function readSheetStart() {
  const date = root.querySelector("#fDate")?.value;
  const time = root.querySelector("#fTime")?.value;
  if (date && time) return new Date(`${date}T${time}`);
  const legacy = root.querySelector("#fStart")?.value;
  return legacy ? new Date(legacy) : new Date();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

if (!isNative() && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}

setupInstall();
onInstallChange(() => render());

bootNative();
if (!isNative()) {
  ensurePermission({ interactive: false }).then(async (n) => {
    ui.native = n;
    if (!n && isStandalone() && Notification.permission === "granted") {
      await setupWebPush();
    }
    await refreshTickGate();
  });
}
plugin("LocalNotifications")?.addListener?.("localNotificationActionPerformed", (action) => {
  const extra = action?.notification?.extra || {};
  if (extra.kind === "sleep-notes" || extra.openView === "notes") {
    ui.view = "notes";
    render();
  }
});

onAppActive(async () => {
  if (!isNative() && isStandalone() && Notification.permission === "granted") {
    await setupWebPush();
  }
  if (ui.familyMe?.ok && !isParent()) {
    const changed = await refreshSchoolWalk().catch(() => false);
    if (changed) await syncAll(state, "school-walk");
  }
  if (!ui.familyMe?.ok) {
    try {
      const me = await familyMe();
      ui.familyMe = me.ok ? me : null;
    } catch {
      /* stay logged out */
    }
  }
  const { pending } = await prepareForegroundSync(state, "app-active");
  if (pending?.active) {
    ui.challenge = pending;
    ui.challengeInput = ui.challengeInput || "";
  } else {
    ui.challenge = null;
  }
  render();
});
setInterval(() => tickAlarms(state), 30000);
setInterval(() => {
  if (!ui.familyMe?.ok) return;
  void pulsePresence();
  if (isParent() && ui.view === "map") {
    familyGetLocation(watchedMember())
      .then((loc) => {
        ui.familyLoc = loc;
        render();
      })
      .catch(() => {});
  }
}, 60000);
setInterval(() => {
  if (!ui.familyMe?.ok || isParent()) return;
  refreshSchoolWalk()
    .then((changed) => {
      if (changed) return syncAll(state, "school-walk");
    })
    .catch(() => {});
}, 5 * 60 * 1000);

if (typeof location !== "undefined" && new URLSearchParams(location.search).get("view") === "notes") {
  ui.view = "notes";
}

plugin("App")?.addListener?.("appUrlOpen", async ({ url }) => {
  if (/wake-challenge|verify-awake/i.test(String(url || ""))) {
    await refreshChallenge();
    render();
  }
});

load();
