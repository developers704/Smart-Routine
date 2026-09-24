import { formatMonitorWindow, freshnessLabel, isAllDayMonitor, minutesToTimeInput } from "/shared/family.js";
import { ANIKA_WHATSAPP } from "./copy.js";

export function changePasswordHtml(escapeHtml, msg) {
  return `<section class="block">
    <p class="eyebrow">Account</p>
    <h2 class="block-title">Change password</h2>
    <p class="lede">Enter the current password, then a new one. The next sign-in uses the new password.</p>
    <form id="changePasswordForm">
      <label class="field"><span>Current password</span><input id="oldPass" name="current-password" type="password" autocomplete="current-password" required></label>
      <label class="field"><span>New password</span><input id="newPass" name="new-password" type="password" autocomplete="new-password" minlength="6" required></label>
      <div class="sheet-actions"><button type="submit" class="btn primary">Save password</button></div>
    </form>
    ${msg ? `<p class="muted">${escapeHtml(msg)}</p>` : ""}
  </section>`;
}

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
  return `<section class="block loc-enable">
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

function presenceWhen(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function waIcon() {
  return `<svg class="wa-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="#25D366" d="M12 2.04c-5.5 0-9.96 4.46-9.96 9.96 0 1.76.46 3.47 1.34 4.98L2 22l5.16-1.35A9.93 9.93 0 0 0 12 21.96c5.5 0 9.96-4.46 9.96-9.96S17.5 2.04 12 2.04z"/><path fill="#fff" d="M16.7 14.3c-.22-.11-1.3-.64-1.5-.71-.2-.08-.35-.11-.5.11-.15.22-.57.71-.7.86-.13.15-.26.16-.48.05-.22-.11-.93-.34-1.77-1.1-.65-.58-1.1-1.3-1.22-1.52-.13-.22-.01-.34.1-.45.1-.1.22-.26.33-.4.11-.13.15-.22.22-.37.08-.15.04-.28-.02-.4-.05-.11-.5-1.2-.68-1.64-.18-.43-.36-.37-.5-.38h-.42c-.15 0-.4.05-.6.28-.22.22-.8.78-.8 1.9 0 1.12.82 2.2.93 2.35.11.15 1.62 2.47 3.92 3.46.55.24.98.38 1.31.48.55.18 1.05.15 1.45.09.44-.07 1.3-.53 1.48-1.05.18-.51.18-.96.13-1.05-.05-.1-.2-.15-.42-.26z"/></svg>`;
}

function memberChoices(loc) {
  const fromServer = Array.isArray(loc?.members) ? loc.members.filter((m) => m?.username) : [];
  if (fromServer.length) return fromServer;
  return [
    { id: "user_anika", username: "anika", name: "Anika" },
    { id: "user_owais", username: "owais", name: "Owais" },
  ];
}

function memberSwitchHtml(loc, escapeHtml, { eyebrow, title }) {
  const members = memberChoices(loc);
  const current = members.find((m) => m.username === loc?.member?.username) || members[0];
  const heading = title || current?.name || "Anika";
  const who = title ? current?.name || "Anika" : "";
  return `<div class="member-switch pick" data-pick="member">
    <button type="button" class="pick-btn member-switch-btn" aria-haspopup="listbox" aria-expanded="false">
      <span>
        <span class="eyebrow">${escapeHtml(eyebrow)}</span>
        <span class="block-title">${escapeHtml(heading)}</span>
        ${who ? `<span class="member-switch-who">${escapeHtml(who)}</span>` : `<span class="member-switch-who">Choose Anika or Owais</span>`}
      </span>
    </button>
    <div class="pick-list" role="listbox" aria-label="${escapeHtml(title || "Person")}">
      ${members
        .map(
          (m) =>
            `<button type="button" role="option" class="pick-opt ${m.username === current?.username ? "on" : ""}" data-member="${escapeHtml(m.username)}">${escapeHtml(m.name || m.username)}</button>`
        )
        .join("")}
    </div>
  </div>`;
}

export function parentMapHtml(loc, escapeHtml) {
  const person = loc?.member?.name || "Anika";
  const username = loc?.member?.username || "anika";
  const label = loc?.freshnessLabel || freshnessLabel(loc?.freshness);
  const status = loc?.status === "home" ? "Home" : loc?.status === "away" ? "Away" : "Unknown";
  const visits = (loc?.visits || [])
    .map(
      (v) =>
        `<li>${escapeHtml(v.name || "Home")}: arrived ${escapeHtml(v.arrivedAt || "—")}, left ${escapeHtml(v.departedAt || "still there")}, ~${v.durationMin || 0} min</li>`
    )
    .join("");
  const row = (loc?.presence || []).find((p) => p.username === username);
  const presence = row
    ? `<p class="muted">${escapeHtml(row.name || row.username)} · ${escapeHtml(row.platform || "Web")} · ${
        row.online
          ? `online since ${escapeHtml(presenceWhen(row.since))}`
          : `last seen ${escapeHtml(presenceWhen(row.lastSeen))}`
      }</p>`
    : `<p class="muted">Not signed in yet</p>`;
  const call =
    username === "anika"
      ? `<a class="wa-call" href="${ANIKA_WHATSAPP.href}" target="_blank" rel="noopener noreferrer" data-wa>
        ${waIcon()}
        <span>Call Anika</span>
      </a>`
      : "";
  return `<section class="block family-map-card">
    <div class="family-map-head">
      ${memberSwitchHtml(loc, escapeHtml, { eyebrow: "Map", title: "" })}
      ${call}
    </div>
    <p class="lede">${escapeHtml(label || "Unavailable")} · ${status}</p>
    ${presence}
    <p class="muted">Last updated ${escapeHtml(loc?.updatedAt || "—")}.</p>
    <div id="familyMap" class="travel-map family-map" role="application" aria-label="${escapeHtml(person)} location map"></div>
    <h3 class="subh">Today</h3>
    <ul class="muted visit-list">${visits || "<li>No visits at saved places yet.</li>"}</ul>
  </section>`;
}

export function parentSettingsHtml(me, loc, escapeHtml, msg, passwordMsg = "") {
  const home = loc?.home || {};
  const name = me?.user?.username || "Kash";
  const startMin = home.startMin ?? 0;
  const endMin = home.endMin ?? 300;
  const allDay = isAllDayMonitor({ startMin, endMin });
  const windowLabel = formatMonitorWindow({ startMin, endMin });
  const person = loc?.member?.name || "Anika";
  return `<section class="block settings-page">
    ${memberSwitchHtml(loc, escapeHtml, { eyebrow: "Settings", title: "Location pin" })}
    <p class="lede">Pin for ${escapeHtml(person)}. Alerts run ${escapeHtml(windowLabel)}. One Away alert, then one Returned Home update. Change the times to test now — you do not have to wait until midnight.</p>
    <label class="field"><span>Latitude</span><input id="homeLat" inputmode="decimal" value="${home.lat ?? ""}"></label>
    <label class="field"><span>Longitude</span><input id="homeLng" inputmode="decimal" value="${home.lng ?? ""}"></label>
    <label class="field"><span>Radius (m)</span><input id="homeRadius" inputmode="numeric" value="${home.radiusM ?? 150}"></label>
    <label class="check-opt"><input id="homeAllDay" type="checkbox" ${allDay ? "checked" : ""}>
      <span>Alert all day</span></label>
    <label class="field"><span>Alert from</span>
      <input id="homeStart" type="time" value="${minutesToTimeInput(startMin)}" ${allDay ? "disabled" : ""}>
    </label>
    <label class="field"><span>Alert until</span>
      <input id="homeEnd" type="time" value="${minutesToTimeInput(allDay ? 300 : endMin)}" ${allDay ? "disabled" : ""}>
    </label>
    <div class="sheet-actions"><button type="button" class="btn primary" id="saveHome">Save location pin</button></div>
    <p class="muted">Alerts include the last location timestamp. They are not a guaranteed alarm and may not break through Silent or Focus.</p>
  </section>
  ${changePasswordHtml(escapeHtml, passwordMsg)}
  <section class="block settings-page">
    <p class="eyebrow">Account</p>
    <h2 class="block-title">${escapeHtml(name)}</h2>
    <div class="sheet-actions">
      <button type="button" class="btn" id="deleteHistory">Delete location history</button>
      <button type="button" class="btn" id="familySignOut">Sign out</button>
    </div>
    ${msg ? `<p class="muted">${escapeHtml(msg)}</p>` : ""}
  </section>`;
}

export function parentNavHtml(view, navIcon) {
  return `<nav class="nav nav-2" aria-label="Parent">
    <button class="${view === "map" ? "primary" : ""}" data-view="map">${navIcon("map")}<span>Map</span></button>
    <button class="${view === "settings" ? "primary" : ""}" data-view="settings">${navIcon("set")}<span>Settings</span></button>
  </nav>`;
}
