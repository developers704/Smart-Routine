import { DEFAULT_SETTINGS } from "/shared/defaults.js";
import { planRange, warningsFor, mergePlan, dedupeEvents } from "/shared/scheduler.js";
import {
  addDays,
  durationMin,
  eachDate,
  fmtRange,
  fmtTime,
  fromISO,
  isoDate,
  startOfWeek,
  uid,
} from "/shared/time.js";
import { ensurePermission, scheduleNative, tickAlarms } from "./alarms.js";
import { bootNative, haptic, isNative, onAppActive } from "./native.js";
import { bannerHtml, bindInstallBanner, isStandalone, onInstallChange, setupInstall } from "./install.js";
import { setupWebPush } from "./push.js";
import { CAT, DAD_WHATSAPP, DAYS_LONG, DAYS_SHORT, MONTHS, TONE, WEEK_HD, needsDadCall, prettyDur, prettyNotes, prettyTitle, prettyWarn } from "./copy.js";
import { ensurePlaces, geocode, roundLeaveLocal } from "/shared/travel.js";
import { bindMap, bindPlaceSheet, destroyMap, destroyPlaceMap, mapViewHtml, placeSheetHtml } from "./map-tab.js";

const root = document.getElementById("app");
const SHIFTS = ["M", "M+A", "E+N", "N"];

const ui = {
  view: "today",
  selected: isoDate(new Date()),
  monthCursor: isoDate(new Date()).slice(0, 7),
  sheet: null,
  native: null,
  travel: {
    purpose: "office",
    fromId: "place_home",
    toId: "place_office",
    mode: "walking",
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

async function api(path, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      ...opts,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function load() {
  try {
    state = await api("/api/state");
    state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
  } catch {
    try {
      const cached = localStorage.getItem("routine-state");
      if (cached) state = { ...state, ...JSON.parse(cached) };
    } catch {
      /* ignore bad cache */
    }
  }
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  state.events = state.events || [];
  state.notes = state.notes || [];
  state.shifts = state.shifts || {};
  state.events = dedupeEvents(state.events || []);
  state.places = ensurePlaces(state.places);
  persistLocal();
  try {
    await api("/api/state", { method: "PUT", body: JSON.stringify(state) });
  } catch {
    /* offline */
  }
  render();
}

function persistLocal() {
  localStorage.setItem("routine-state", JSON.stringify(state));
}

async function save() {
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
      const userEvents = prev.filter((e) => e.source === "user");
      const keep = prev.filter((e) => e.source === "auto" && e.locked);
      const generated = planRange({
        shifts: state.shifts,
        userEvents,
        keep,
        settings: state.settings,
        from,
        to,
      });
      state.events = mergePlan(prev, generated, from, to);
      state.warnings = warningsFor(generated, state.shifts, state.settings);
      state.generatedAt = new Date().toISOString();
    }
    await save();
    if (ui.native) scheduleNative(state, ui.native);
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
  if (ui.native) scheduleNative(state, ui.native);
  render();
}

function eventsOn(date) {
  return dedupeEvents(state.events || [])
    .filter((e) => (e.date || isoDate(fromISO(e.start))) === date)
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

function render() {
  try {
  const date = ui.selected;
  const code = (state.shifts || {})[date] || null;
  root.innerHTML = `
    ${bannerHtml()}
    <header class="hero">
      <div class="top">
        <div>
          <h1 class="brand">Smart <span>Routine</span></h1>
          <p class="lede">${
            ui.view === "map"
              ? "Pick a purpose and leave time. The map fills distance, ETA, and a 10-minute alarm."
              : "Set the shift. Everything else fills in around it."
          }</p>
        </div>
        <button class="btn primary" id="gen">Build schedule</button>
      </div>
    </header>
    ${
      ui.view === "map"
        ? ""
        : `${weekBar()}
    <div class="dayhead">
      <strong>${heading()}</strong>
      <button class="btn small" id="todayBtn">Today</button>
    </div>
    <div class="shift-pick" role="group" aria-label="Shift for this day">
      <button data-shift="" aria-pressed="${!code}">Off</button>
      ${SHIFTS.map(
        (s) =>
          `<button data-shift="${s}" aria-pressed="${code === s}">${s}</button>`
      ).join("")}
    </div>
    ${statsRow(date)}
    ${(state.warnings || [])
      .filter((w) => w.date === date)
      .map((w) => `<div class="warn">${escapeHtml(prettyWarn(w.text))}</div>`)
      .join("")}`
    }
    ${viewBody()}
    <nav class="nav nav-5">
      <button class="${ui.view === "today" ? "primary" : ""}" data-view="today"><span class="dot">◆</span>Day</button>
      <button class="${ui.view === "month" ? "primary" : ""}" data-view="month"><span class="dot">▦</span>Month</button>
      <button class="${ui.view === "map" ? "primary" : ""}" data-view="map"><span class="dot">◉</span>Map</button>
      <button class="${ui.view === "notes" ? "primary" : ""}" data-view="notes"><span class="dot">✎</span>Notes</button>
      <button class="${ui.view === "settings" ? "primary" : ""}" data-view="settings"><span class="dot">◍</span>Set</button>
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
      const code = state.shifts[d];
      return `<button class="daychip ${d === ui.selected ? "on" : ""}" data-day="${d}">
        <div class="d">${DAYS_SHORT[dt.getDay()]}</div>
        <div class="n">${dt.getDate()}</div>
        <span class="shift ${shiftClass(code)}">${code || "Off"}</span>
      </button>`;
    })
    .join("")}</div>`;
}

function statsRow(date) {
  const ev = eventsOn(date);
  const done = ev.filter((e) => e.done).length;
  const study = ev.filter((e) => e.kind === "mcat").reduce((s, e) => s + durationMin(e.start, e.end), 0);
  const sleep = ev
    .filter((e) => e.kind === "sleep" || e.kind === "recovery")
    .reduce((s, e) => s + durationMin(e.start, e.end), 0);
  return `<div class="stats">
    <div class="stat"><b>${done}/${ev.length || 0}</b><span>done</span></div>
    <div class="stat"><b>${(study / 60).toFixed(1)}h</b><span>MCAT today</span></div>
    <div class="stat"><b>${(sleep / 60).toFixed(1)}h</b><span>sleep</span></div>
  </div>`;
}

function viewBody() {
  if (ui.view === "month") return monthView();
  if (ui.view === "map") return mapViewHtml(state, ui, { escapeHtml, toLocalInput });
  if (ui.view === "notes") return notesView();
  if (ui.view === "settings") return settingsView();
  return dayView();
}

function dayView() {
  const ev = eventsOn(ui.selected);
  if (!ev.length) {
    return `<div class="empty">No plan yet. Pick a shift — the day fills in for you.
      <div style="margin-top:12px"><button class="btn" id="addEvent">Add event</button></div></div>`;
  }
  return `<div class="timeline">${ev.map(cardHtml).join("")}</div>
    <div class="row" style="margin-top:12px">
      <button class="btn" id="addEvent">Add event</button>
    </div>
    <p class="muted" style="margin-top:8px">On any card: Edit to change time, Remove to delete.</p>`;
}

function dadCallBtn(e) {
  if (!needsDadCall(e)) return "";
  return `<a class="btn small" href="${DAD_WHATSAPP.href}" target="_blank" rel="noopener noreferrer" data-wa>Call</a>`;
}

function cardHtml(e) {
  const tone = TONE[e.category] || "personal";
  const sub = e.subtitle && !/call parents/i.test(e.subtitle) ? e.subtitle : "";
  return `<article class="card tone-${tone} ${e.done ? "done" : ""}" data-id="${e.id}">
    <button class="check ${e.done ? "on" : ""}" data-check="${e.id}" aria-label="Mark complete"></button>
    <div>
      <div class="tag">${CAT[e.category] || e.category}${e.source === "user" ? " · yours" : ""}</div>
      <h3>${escapeHtml(prettyTitle(e))}</h3>
      <p>${fmtRange(e.start, e.end)}${sub ? " · " + escapeHtml(sub) : ""}${
        e.alarm !== false ? " · alarm" : ""
      }</p>
      ${prettyNotes(e) ? `<p>${escapeHtml(prettyNotes(e))}</p>` : ""}
      <div class="card-actions">
        <button type="button" class="btn small" data-edit="${e.id}">Edit</button>
        <button type="button" class="btn small danger" data-remove="${e.id}">Remove</button>
        ${dadCallBtn(e)}
      </div>
    </div>
    <div class="when">${fmtTime(e.start)}<br>${prettyDur(durationMin(e.start, e.end))}</div>
  </article>`;
}

function monthView() {
  const [y, m] = ui.monthCursor.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const start = startOfWeek(isoDate(first));
  const end = addDays(start, 41);
  const days = eachDate(start, end);
  const hd = WEEK_HD;
  return `<div class="row" style="margin-bottom:10px">
      <button class="btn small" id="prevM">Prev</button>
      <strong>${MONTHS[first.getMonth()]} ${first.getFullYear()}</strong>
      <button class="btn small" id="nextM">Next</button>
    </div>
    <div class="month">${hd.map((h) => `<div class="hd">${h}</div>`).join("")}${days
      .map((d) => {
        const code = state.shifts[d];
        const out = d.slice(0, 7) !== ui.monthCursor;
        return `<button class="cell ${out ? "out" : ""}" data-day="${d}">
          <div class="num">${Number(d.slice(8))}</div>
          <span class="shift ${shiftClass(code)}">${code || "Off"}</span>
        </button>`;
      })
      .join("")}</div>`;
}

function notesView() {
  const notes = state.notes || [];
  return `<p class="muted">Quick notes. You’ll get a reminder at the end of the day so they don’t disappear.</p>
    <div class="field"><textarea id="newNote" rows="3" placeholder="Something to do later…"></textarea></div>
    <button class="btn primary" id="saveNote">Save</button>
    <div style="margin-top:16px">${
      notes.length
        ? notes
            .map(
              (n) => `<div class="note">
              <p>${escapeHtml(n.text)}</p>
              <div class="row" style="margin-top:8px">
                <button class="btn small" data-to-event="${n.id}">Turn into event</button>
                <button class="btn small ghost" data-del-note="${n.id}">Delete</button>
              </div>
            </div>`
            )
            .join("")
        : `<div class="empty">No notes yet.</div>`
    }</div>`;
}

function settingsView() {
  const s = state.settings;
  const fields = [
    ["commuteMin", "Commute each way (min)"],
    ["jkStartMin", "JK start (minutes from midnight)"],
    ["jkDurationMin", "JK length (min)"],
    ["mcatWorkMin", "MCAT on work days (min)"],
    ["mcatOffMin", "MCAT on off days (min)"],
    ["sleepWorkMin", "Sleep on work nights (min)"],
    ["sleepOffMin", "Sleep on off days (min)"],
    ["gymMin", "Gym session (min)"],
    ["alarmLeadMin", "Alarm lead time (min)"],
    ["notepadRemindMin", "Notepad reminder (minutes from midnight)"],
  ];
  return `<p class="muted">These are the defaults used when a schedule is built. Tap any card to change that block, or apply it to future days.</p>
    ${fields
      .map(
        ([k, label]) => `<label class="field">${label}
      <input type="number" data-setting="${k}" value="${s[k]}"></label>`
      )
      .join("")}
    <label class="row" style="margin:12px 0"><input type="checkbox" id="callParents" ${
      s.callParentsOnCommute ? "checked" : ""
    }> WhatsApp Dad during commutes</label>
    <button class="btn primary" id="saveSettings">Save</button>`;
}

function sheetHtml() {
  const sh = ui.sheet;
  if (sh.type === "event") {
    const e = sh.event;
    const start = fromISO(e.start);
    const local = toLocalInput(start);
    const dur = durationMin(e.start, e.end);
    return `<div class="sheet" id="sheet"><div class="panel">
      <h2>${e.id ? "Edit block" : "New event"}</h2>
      <label class="field">Title <input id="fTitle" value="${escapeAttr(e.title || "")}"></label>
      <label class="field">Start <input id="fStart" type="datetime-local" value="${local}"></label>
      <label class="field">Duration (min) <input id="fDur" type="number" value="${dur}"></label>
      <label class="field">Type
        <select id="fCat">${Object.keys(CAT)
          .map((k) => `<option value="${k}" ${e.category === k ? "selected" : ""}>${CAT[k]}</option>`)
          .join("")}</select>
      </label>
      <label class="row"><input type="checkbox" id="fAlarm" ${e.alarm !== false ? "checked" : ""}> Alarm</label>
      <label class="row"><input type="checkbox" id="fRecur" ${e.recurring ? "checked" : ""}> Repeat weekly</label>
      ${
        e.source === "auto"
          ? `<label class="row"><input type="checkbox" id="fFuture"> Also change future days</label>`
          : ""
      }
      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="saveEv">Save</button>
        ${e.id ? `<button class="btn danger" id="delEv">Remove event</button>` : ""}
        <button class="btn ghost" id="closeSheet">Close</button>
      </div>
    </div></div>`;
  }
  if (sh.type === "place") return placeSheetHtml(sh, { escapeHtml, escapeAttr });
  if (sh.type === "fromNote") {
    return `<div class="sheet" id="sheet"><div class="panel">
      <h2>Note to event</h2>
      <p>${escapeHtml(sh.note.text)}</p>
      <label class="field">When <input id="fStart" type="datetime-local" value="${toLocalInput(new Date())}"></label>
      <label class="field">Duration (min) <input id="fDur" type="number" value="60"></label>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="noteToEv">Create event</button>
        <button class="btn ghost" id="closeSheet">Close</button>
      </div>
    </div></div>`;
  }
  return "";
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
  root.querySelectorAll("[data-shift]").forEach((el) =>
    el.addEventListener("click", async () => {
      const v = el.dataset.shift || null;
      if (v) state.shifts[ui.selected] = v;
      else delete state.shifts[ui.selected];
      haptic("light");
      await save();
      await generate();
    })
  );
  root.querySelectorAll("[data-view]").forEach((el) =>
    el.addEventListener("click", () => {
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
      if (ev.target.closest("[data-check], [data-edit], [data-remove], [data-wa]")) return;
      openEvent(el.dataset.id);
    })
  );
  root.querySelector("#addEvent")?.addEventListener("click", () => {
    const start = new Date(ui.selected + "T12:00:00");
    ui.sheet = {
      type: "event",
      event: {
        title: "",
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
  });
  root.querySelector("#saveNote")?.addEventListener("click", async () => {
    const text = root.querySelector("#newNote").value.trim();
    if (!text) return;
    state.notes.unshift({ id: uid("n"), text, createdAt: new Date().toISOString(), converted: false });
    await save();
    render();
  });
  root.querySelectorAll("[data-del-note]").forEach((el) =>
    el.addEventListener("click", async () => {
      state.notes = state.notes.filter((n) => n.id !== el.dataset.delNote);
      await save();
      render();
    })
  );
  root.querySelectorAll("[data-to-event]").forEach((el) =>
    el.addEventListener("click", () => {
      const note = state.notes.find((n) => n.id === el.dataset.toEvent);
      ui.sheet = { type: "fromNote", note };
      render();
    })
  );
  root.querySelector("#saveSettings")?.addEventListener("click", async () => {
    root.querySelectorAll("[data-setting]").forEach((inp) => {
      state.settings[inp.dataset.setting] = Number(inp.value);
    });
    state.settings.callParentsOnCommute = root.querySelector("#callParents").checked;
    await save();
    render();
  });
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
      scheduleNative,
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
  }
  if (ui.sheet?.type === "place") bindPlaceSheet(root, { haptic });
  else destroyPlaceMap();
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
  root.querySelector("#saveEv")?.addEventListener("click", async () => {
    const title = root.querySelector("#fTitle").value.trim() || "Event";
    const start = new Date(root.querySelector("#fStart").value);
    const dur = Number(root.querySelector("#fDur").value) || 60;
    const category = root.querySelector("#fCat").value;
    const alarm = root.querySelector("#fAlarm").checked;
    const recur = root.querySelector("#fRecur")?.checked;
    const future = root.querySelector("#fFuture")?.checked;
    const orig = ui.sheet.event;
    const patch = {
      ...orig,
      title,
      category,
      start: start.toISOString(),
      end: new Date(start.getTime() + dur * 60000).toISOString(),
      date: isoDate(start),
      alarm,
      locked: orig.source === "auto",
      recurring: recur
        ? { freq: "weekly", weekdays: [start.getDay()] }
        : null,
      source: orig.source || "user",
    };
    if (!orig.id) {
      patch.id = uid("user");
      patch.source = "user";
      state.events.push(patch);
    } else {
      const i = state.events.findIndex((e) => e.id === orig.id);
      if (i >= 0) state.events[i] = { ...state.events[i], ...patch, id: orig.id };
      if (future && orig.templateKey) applyFuture(orig.templateKey, dur, start);
    }
    ui.sheet = null;
    await save();
    if (ui.native) scheduleNative(state, ui.native);
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
  root.querySelector("#noteToEv")?.addEventListener("click", async () => {
    const start = new Date(root.querySelector("#fStart").value);
    const dur = Number(root.querySelector("#fDur").value) || 60;
    const note = ui.sheet.note;
    state.events.push({
      id: uid("user"),
      title: note.text.slice(0, 80),
      category: "personal",
      kind: "personal",
      start: start.toISOString(),
      end: new Date(start.getTime() + dur * 60000).toISOString(),
      date: isoDate(start),
      done: false,
      alarm: true,
      source: "user",
      notes: note.text,
    });
    note.converted = true;
    ui.sheet = null;
    await save();
    ui.view = "today";
    ui.selected = isoDate(start);
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
ensurePermission().then(async (n) => {
  ui.native = n;
  if (n) scheduleNative(state, n);
  else if (!isNative() && isStandalone() && Notification.permission === "granted") {
    await setupWebPush();
  }
});
onAppActive(async () => {
  if (ui.native) scheduleNative(state, ui.native);
  else if (!isNative() && isStandalone() && Notification.permission === "granted") {
    await setupWebPush();
  }
});
setInterval(() => tickAlarms(state), 30000);

load();
