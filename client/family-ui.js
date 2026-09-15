import { freshnessLabel } from "/shared/family.js";

export const FAMILY_SHARING_SETUP =
  "Family Sharing setup required. On this iPhone open Settings → Family, add Anika as a child under Apple Family Sharing, then tap Enable Family Screen Time here. Apple keeps Screen Time on the device — this app never uploads minutes or app tokens.";

export function familyLoginHtml(profiles, escapeHtml, msg) {
  return `<header class="hero">
    <div class="top"><div>
      <h1 class="brand">Family <span>Tracker</span></h1>
      <p class="lede">Choose who is using this iPhone. Names are development profiles — sign-in mints a random session, not a password.</p>
    </div></div>
  </header>
  <section class="block">
    <p class="eyebrow">Who’s this?</p>
    <h2 class="block-title">Sign in</h2>
    ${(profiles || [])
      .map(
        (p) =>
          `<button type="button" class="btn ${p.role === "parent" ? "primary" : ""}" data-family-signin="${escapeHtml(p.id)}">${escapeHtml(p.name)} · ${p.role === "parent" ? "Parent" : "Member"}</button>`
      )
      .join("")}
    ${msg ? `<p class="muted">${escapeHtml(msg)}</p>` : ""}
  </section>`;
}

export function shareWithKashHtml(me, locStatus, escapeHtml) {
  const linked = Boolean(me?.family?.linked);
  const paused = Boolean(me?.sharing?.paused);
  const auth = locStatus?.authorization || "notDetermined";
  const sharingOn = linked && !paused && (auth === "always" || auth === "whenInUse");
  return `<section class="block family-share">
    <p class="eyebrow">Family</p>
    <h2 class="block-title">Share with Kash</h2>
    <p class="lede">Location sharing is optional and visible. Screen Time stays on this iPhone.</p>
    <div class="note-card notify-status">
      <p><b>${linked ? "Linked to Kash" : "Not linked"}</b><br>
      <span class="muted">${paused ? "Sharing paused" : sharingOn ? "Location sharing is on" : "Location is not being shared yet"}</span></p>
    </div>
    ${
      linked
        ? ""
        : `<label class="field"><span>Pairing code from Kash</span>
        <input id="pairCode" inputmode="text" autocomplete="off" placeholder="8-character code"></label>
        <div class="sheet-actions"><button type="button" class="btn primary" id="pairParent">Link to Kash</button></div>`
    }
    ${
      linked
        ? `<p class="lede">Step 1 — allow While Using so Smart Routine can read this iPhone’s location. Step 2 — Always is only requested if you tap the button below. Always is needed so Kash can see a last-known place and overnight Home alerts when the app is in the background.</p>
        <div class="sheet-actions">
          <button type="button" class="btn primary" id="locWhenInUse">Allow While Using</button>
          ${
            auth === "whenInUse" || auth === "always"
              ? `<button type="button" class="btn" id="locAlways">Allow Always Location</button>`
              : `<button type="button" class="btn" id="locAlways" disabled>Allow Always Location</button>`
          }
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn" id="pauseSharing">${paused ? "Resume location sharing" : "Pause location sharing"}</button>
          <button type="button" class="btn" id="removeParent">Remove Parent</button>
          <button type="button" class="btn" id="familySignOutMember">Sign out</button>
        </div>`
        : ""
    }
  </section>`;
}

export function sharingBannerHtml(me) {
  if (!me?.family?.linked || me?.sharing?.paused) return "";
  return `<div class="family-banner" role="status">Sharing location with Kash</div>`;
}

export function parentOverviewHtml(me, loc, escapeHtml) {
  const label = loc?.freshnessLabel || freshnessLabel(loc?.freshness);
  const updated = loc?.updatedAt ? loc.updatedAt.replace("T", " ").replace("Z", " UTC") : "No fix yet";
  const status = loc?.status === "home" ? "Home" : loc?.status === "away" ? "Away" : "Unknown";
  return `<header class="hero">
    <div class="top"><div>
      <h1 class="brand">Family <span>Tracker</span></h1>
      <p class="lede">Kash’s dashboard. Routines and alarms stay on Anika’s iPhone.</p>
    </div></div>
  </header>
  <section class="block">
    <p class="eyebrow">Overview</p>
    <h2 class="block-title">Anika</h2>
    <p class="lede">${me?.family?.linked ? "Linked member" : "Waiting for Anika to enter a pairing code."}</p>
    <div class="stats">
      <div class="stat"><b>${escapeHtml(status)}</b><span>place</span></div>
      <div class="stat"><b>${escapeHtml(label || "Unavailable")}</b><span>location</span></div>
    </div>
    <p class="muted">Last updated ${escapeHtml(updated)}. Never labeled Live when the fix is stale.</p>
    <p class="muted">Overnight Home alerts are a notification with sound — not an alarm, and they may not break through Silent or Focus.</p>
  </section>`;
}

export function parentActivityHtml(st, escapeHtml, range) {
  const setup = st?.familySharingRequired || st?.authorization === "denied";
  const ready = Boolean(st?.supported && st?.authorization === "authorized" && st?.users === "children");
  return `<section class="block">
    <p class="eyebrow">Screen Time</p>
    <h2 class="block-title">Anika’s activity</h2>
    <p class="lede">History for Today and Last 7 Days comes from Apple Family Controls and DeviceActivityReport for children. Totals never leave the iPhone.</p>
    ${
      setup || !ready
        ? `<div class="note-card warn-card"><p><b>Family Sharing setup required</b><br><span class="muted">${escapeHtml(FAMILY_SHARING_SETUP)}</span></p></div>`
        : `<div class="note-card notify-status"><p><b>Family Screen Time</b><br><span class="muted">Authorized for children. Choose apps, then the system report shows total time, Social, and per-app duration.</span></p></div>`
    }
    <div class="sheet-actions">
      <button type="button" class="btn primary" id="enableFamilyScreenTime">Enable Family Screen Time</button>
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
  const liveClaim = loc?.live ? "error" : "";
  const visits = (loc?.visits || [])
    .map(
      (v) =>
        `<li>${escapeHtml(v.name || "Home")}: arrived ${escapeHtml(v.arrivedAt || "—")}, left ${escapeHtml(v.departedAt || "still there")}, ~${v.durationMin || 0} min</li>`
    )
    .join("");
  return `<section class="block">
    <p class="eyebrow">Map</p>
    <h2 class="block-title">Anika’s location</h2>
    <p class="lede">${escapeHtml(label || "Unavailable")} · ${loc?.status === "home" ? "Home" : loc?.status === "away" ? "Away" : "Unknown"}${liveClaim}</p>
    <p class="muted">Last updated ${escapeHtml(loc?.updatedAt || "—")}. Apple Family Sharing is not required for location.</p>
    <div id="familyMap" class="travel-map family-map"></div>
    <h3 class="block-title">Today</h3>
    <ul class="muted">${visits || "<li>No visits at saved places yet.</li>"}</ul>
  </section>`;
}

export function parentSettingsHtml(me, loc, invite, escapeHtml, msg) {
  const home = loc?.home || {};
  return `<section class="block">
    <p class="eyebrow">Pairing</p>
    <h2 class="block-title">Invite Anika</h2>
    <p class="lede">Share this one-time code. It is hashed on the server.</p>
    <p class="stat"><b>${escapeHtml(invite || "Tap Create code")}</b></p>
    <div class="sheet-actions"><button type="button" class="btn primary" id="createInvite">Create code</button></div>
  </section>
  <section class="block">
    <p class="eyebrow">Home</p>
    <h2 class="block-title">Overnight geofence</h2>
    <p class="lede">Default window is 12:00 AM–5:00 AM. One Away alert, then one Returned Home update.</p>
    <label class="field"><span>Latitude</span><input id="homeLat" value="${home.lat ?? ""}"></label>
    <label class="field"><span>Longitude</span><input id="homeLng" value="${home.lng ?? ""}"></label>
    <label class="field"><span>Radius (m)</span><input id="homeRadius" value="${home.radiusM ?? 150}"></label>
    <label class="field"><span>Window start (min from midnight)</span><input id="homeStart" value="${home.startMin ?? 0}"></label>
    <label class="field"><span>Window end</span><input id="homeEnd" value="${home.endMin ?? 300}"></label>
    <div class="sheet-actions"><button type="button" class="btn primary" id="saveHome">Save Home</button></div>
    <p class="muted">Alerts include the last location timestamp. They are not guaranteed through Silent or Focus.</p>
  </section>
  <section class="block">
    <p class="eyebrow">Privacy</p>
    <h2 class="block-title">Data</h2>
    <div class="sheet-actions">
      <button type="button" class="btn" id="deleteHistory">Delete location history</button>
      <button type="button" class="btn" id="unlinkFamily">Unlink accounts</button>
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
