import { freshnessLabel } from "/shared/family.js";

export function familyLoginHtml(escapeHtml, msg) {
  return `<header class="hero">
    <div class="top"><div>
      <h1 class="brand">Smart <span>Routine</span></h1>
      <p class="lede">Sign in with your username and password.</p>
    </div></div>
  </header>
  <section class="block">
    <p class="eyebrow">Account</p>
    <h2 class="block-title">Sign in</h2>
    <form id="familyLoginForm">
      <label class="field"><span>Username</span><input id="loginUser" name="username" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input id="loginPass" name="password" type="password" autocomplete="current-password" required></label>
      <div class="sheet-actions"><button type="submit" class="btn primary">Sign In</button></div>
    </form>
    ${msg ? `<p class="muted">${escapeHtml(msg)}</p>` : ""}
  </section>`;
}

/** Map tab only — one button. Location posts to the family feed; no sharing copy. */
export function memberEnableLocationHtml() {
  return `<section class="block">
    <div class="sheet-actions">
      <button type="button" class="btn primary" id="locWhenInUse">Enable Location</button>
    </div>
  </section>`;
}

export function memberSignOutHtml() {
  return `<section class="block">
    <div class="sheet-actions">
      <button type="button" class="btn" id="familySignOutMember">Sign out</button>
    </div>
  </section>`;
}

export function parentOverviewHtml(me, loc, escapeHtml) {
  const label = loc?.freshnessLabel || freshnessLabel(loc?.freshness);
  const updated = loc?.updatedAt ? loc.updatedAt.replace("T", " ").replace("Z", " UTC") : "No update yet";
  const status = loc?.status === "home" ? "Home" : loc?.status === "away" ? "Away" : "Unknown";
  const event =
    loc?.lastAlert === "returned"
      ? `Returned home ${escapeHtml(loc.lastAlertAt || "")}`
      : loc?.lastAlert === "away"
        ? `Away ${escapeHtml(loc.lastAlertAt || "")}`
        : "No overnight Home event yet";
  return `<header class="hero">
    <div class="top"><div>
      <h1 class="brand">Family <span>Tracker</span></h1>
      <p class="lede">Anika’s location and activity. Routines stay on her iPhone.</p>
    </div></div>
  </header>
  <section class="block">
    <p class="eyebrow">Overview</p>
    <h2 class="block-title">Anika</h2>
    <div class="stats">
      <div class="stat"><b>${escapeHtml(status)}</b><span>place</span></div>
      <div class="stat"><b>${escapeHtml(label || "Unavailable")}</b><span>location</span></div>
    </div>
    <p class="muted">Last-known location updated ${escapeHtml(updated)}.</p>
    <p class="muted">${event}. Home alerts are a notification with sound — not an alarm, and they may not break through Silent or Focus.</p>
    <p class="eyebrow">Today’s activity</p>
    <div id="activityReportHostOverview" class="activity-report-host" hidden></div>
    <p class="muted">Activity stays on this iPhone. If it cannot be shown, it appears as unavailable.</p>
  </section>`;
}

export function parentActivityHtml(st, escapeHtml, range, native) {
  const ready = Boolean(native && st?.supported);
  return `<section class="block">
    <p class="eyebrow">Activity Access</p>
    <h2 class="block-title">Anika’s activity</h2>
    <p class="lede">Today and Last 7 Days stay on this iPhone. This page never copies times or app names into the account.</p>
    ${
      ready
        ? `<div class="note-card notify-status"><p><b>Activity</b><br><span class="muted">Enable Activity, then choose apps. Total time, Social, Instagram, Snapchat, Facebook, and other top apps appear in the system report when this iPhone can show them.</span></p></div>`
        : `<div class="note-card warn-card"><p><b>Activity unavailable</b><br><span class="muted">Complete device setup in Settings. Apple keeps activity on the iPhone. This app cannot show a copy.</span></p></div>`
    }
    <div class="sheet-actions">
      <button type="button" class="btn primary" id="enableFamilyScreenTime">Enable Activity</button>
      <button type="button" class="btn" id="chooseApps" ${ready ? "" : "disabled"}>Choose Apps</button>
    </div>
    <span class="field-label">Range</span>
    <div class="purpose" role="group" aria-label="Activity range">
      <button type="button" class="chip ${range === "today" ? "on" : ""}" data-activity-range="today">Today</button>
      <button type="button" class="chip ${range === "week" ? "on" : ""}" data-activity-range="week">Last 7 Days</button>
    </div>
    <div id="activityReportHost" class="activity-report-host" hidden></div>
  </section>`;
}

export function parentMapHtml(loc, escapeHtml) {
  const label = loc?.freshnessLabel || freshnessLabel(loc?.freshness);
  const visits = (loc?.visits || [])
    .map(
      (v) =>
        `<li>${escapeHtml(v.name || "Home")}: arrived ${escapeHtml(v.arrivedAt || "—")}, left ${escapeHtml(v.departedAt || "still there")}, ~${v.durationMin || 0} min</li>`
    )
    .join("");
  return `<section class="block">
    <p class="eyebrow">Map</p>
    <h2 class="block-title">Anika’s location</h2>
    <p class="lede">${escapeHtml(label || "Unavailable")} · ${loc?.status === "home" ? "Home" : loc?.status === "away" ? "Away" : "Unknown"}</p>
    <p class="muted">Last updated ${escapeHtml(loc?.updatedAt || "—")}.</p>
    <div id="familyMap" class="travel-map family-map"></div>
    <h3 class="block-title">Today</h3>
    <ul class="muted">${visits || "<li>No visits at saved places yet.</li>"}</ul>
  </section>`;
}

export function parentSettingsHtml(me, loc, escapeHtml, msg) {
  const home = loc?.home || {};
  return `<section class="block">
    <p class="eyebrow">Home</p>
    <h2 class="block-title">Overnight geofence</h2>
    <p class="lede">Default window is 12:00 AM–5:00 AM. One Away alert, then one Returned Home update.</p>
    <label class="field"><span>Latitude</span><input id="homeLat" value="${home.lat ?? ""}"></label>
    <label class="field"><span>Longitude</span><input id="homeLng" value="${home.lng ?? ""}"></label>
    <label class="field"><span>Radius (m)</span><input id="homeRadius" value="${home.radiusM ?? 150}"></label>
    <label class="field"><span>Window start (min from midnight)</span><input id="homeStart" value="${home.startMin ?? 0}"></label>
    <label class="field"><span>Window end</span><input id="homeEnd" value="${home.endMin ?? 300}"></label>
    <div class="sheet-actions"><button type="button" class="btn primary" id="saveHome">Save Home</button></div>
    <p class="muted">Alerts include the last location timestamp. They are not a guaranteed alarm and may not break through Silent or Focus.</p>
  </section>
  <section class="block">
    <p class="eyebrow">Privacy</p>
    <h2 class="block-title">Location history</h2>
    <div class="sheet-actions">
      <button type="button" class="btn" id="deleteHistory">Delete location history</button>
      <button type="button" class="btn" id="familySignOut">Sign out</button>
    </div>
    ${msg ? `<p class="muted">${escapeHtml(msg)}</p>` : ""}
  </section>`;
}

export function parentNavHtml(view, navIcon) {
  return `<nav class="nav nav-4" aria-label="Parent">
    <button class="${view === "overview" ? "primary" : ""}" data-view="overview">${navIcon("day")}<span>Overview</span></button>
    <button class="${view === "activity" ? "primary" : ""}" data-view="activity">${navIcon("activity")}<span>Activity</span></button>
    <button class="${view === "map" ? "primary" : ""}" data-view="map">${navIcon("map")}<span>Map</span></button>
    <button class="${view === "settings" ? "primary" : ""}" data-view="settings">${navIcon("set")}<span>Settings</span></button>
  </nav>`;
}
