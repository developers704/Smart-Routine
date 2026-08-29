import {
  MODES,
  PURPOSES,
  coordOf,
  defaultsForPurpose,
  geocode,
  mapsUrl,
  reverseGeocode,
  routeBetween,
  searchPlaces,
} from "/shared/travel.js";

function purposeLabel(id) {
  return PURPOSES.find((x) => x.id === id)?.label || id;
}

function placeCaption(p) {
  const purpose = PURPOSES.find((x) => x.id === p.purpose)?.label || "";
  const name = p.name || purpose;
  if (!purpose || name.toLowerCase() === purpose.toLowerCase()) return name;
  return `${name} · ${purpose}`;
}

let liveMap = null;

export function destroyMap() {
  if (liveMap) {
    liveMap.remove();
    liveMap = null;
  }
}

function pickHtml(which, current, options, escapeHtml) {
  const cur = options.find((o) => o.id === current) || options[0];
  return `<div class="pick" data-pick="${which}">
    <button type="button" class="pick-btn" aria-haspopup="listbox" aria-expanded="false">${escapeHtml(cur?.label || "Pick…")}</button>
    <div class="pick-list">
      ${options
        .map(
          (o) =>
            `<button type="button" class="pick-opt ${o.id === current ? "on" : ""}" data-val="${escapeHtml(o.id)}">${escapeHtml(o.label)}</button>`
        )
        .join("")}
    </div>
  </div>`;
}

export function mapViewHtml(state, ui, { escapeHtml, toLocalInput }) {
  const t = ui.travel;
  const places = state.places || [];
  const matching = places.filter((p) => p.purpose === t.purpose);
  const toPlace = places.find((p) => p.id === t.toId);
  if (toPlace && toPlace.purpose !== t.purpose) t.toId = matching[0]?.id || "";
  const toOpts = matching.length
    ? matching.map((p) => ({ id: p.id, label: placeCaption(p) }))
    : [{ id: "", label: `Add ${purposeLabel(t.purpose)} first` }];
  const leave = toLocalInput(t.leaveAt);
  const preview = t.preview;
  const needDest = !t.toId;
  return `<section class="travel">
    <p class="muted">Where are you going? Leave time gets a notification and alarm 10 minutes early. Typical time uses the map route (not live traffic).</p>
    <div class="purpose" role="group" aria-label="Travel purpose">
      ${PURPOSES.map(
        (p) =>
          `<button type="button" class="chip ${t.purpose === p.id ? "on" : ""}" data-purpose="${p.id}">${p.label}</button>`
      ).join("")}
    </div>
    <div class="field">From
      ${pickHtml("from", t.fromId, [
        { id: "here", label: "Current location" },
        ...places.map((p) => ({ id: p.id, label: p.name })),
      ], escapeHtml)}
    </div>
    <div class="field">To
      ${pickHtml("to", t.toId, toOpts, escapeHtml)}
    </div>
    ${
      matching.length
        ? ""
        : `<div class="warn">
            Home is set. Now save your <b>${escapeHtml(purposeLabel(t.purpose))}</b> so it can be the destination.
            <div class="row" style="margin-top:10px">
              <button type="button" class="btn primary" id="trAddPlace">Add ${escapeHtml(purposeLabel(t.purpose))}</button>
              <button type="button" class="btn" id="trGpsDest">I'm here — save as ${escapeHtml(purposeLabel(t.purpose))}</button>
            </div>
          </div>`
    }
    ${
      matching.length
        ? `<div class="row">
      <button type="button" class="btn small" id="trHere">Use GPS as start</button>
      <button type="button" class="btn small" id="trAddPlace">Add another place</button>
    </div>`
        : ""
    }
    <div id="travelMap" class="travel-map" role="img" aria-label="Route map"></div>
    <p class="muted map-hint" id="mapHint">Pink is start, green is destination. Quiet map — only your route.</p>
    <label class="field">Time to leave
      <input id="trLeave" type="datetime-local" value="${leave}">
    </label>
    <div class="purpose" role="group" aria-label="How you’ll go">
      ${MODES.map(
        (m) =>
          `<button type="button" class="chip ${t.mode === m.id ? "on" : ""}" data-mode="${m.id}">${m.label}</button>`
      ).join("")}
    </div>
    <div class="row" style="margin:10px 0 12px">
      <button type="button" class="btn primary" id="trRoute" ${needDest ? "disabled" : ""}>Show route</button>
      <button type="button" class="btn" id="trAlarm" ${preview ? "" : "disabled"}>Set leave alarm</button>
    </div>
    ${t.error ? `<div class="warn">${escapeHtml(t.error)}</div>` : ""}
    ${
      preview
        ? `<div class="stats">
            <div class="stat"><b>${preview.km.toFixed(1)} km</b><span>distance</span></div>
            <div class="stat"><b>${preview.min} min</b><span>${preview.source === "osrm" ? "typical" : "estimate"}</span></div>
            <div class="stat"><b>${escapeHtml(preview.arrive)}</b><span>arrive</span></div>
          </div>
          <p class="muted">${escapeHtml(preview.fromName)} → ${escapeHtml(preview.toName)}</p>
          <div class="row" style="margin-bottom:10px">
            <a class="btn small" href="${escapeHtml(preview.maps)}" target="_blank" rel="noopener">Open in Maps</a>
          </div>`
        : ""
    }
    <h3 class="subh">Saved places</h3>
    ${places
      .map(
        (p) => `<div class="note">
          <p><b>${escapeHtml(placeCaption(p))}</b><br>${escapeHtml(p.address)}</p>
          <div class="row" style="margin-top:8px">
            <button type="button" class="btn small ghost" data-del-place="${p.id}">Remove</button>
          </div>
        </div>`
      )
      .join("")}
    <h3 class="subh">Upcoming leave alarms</h3>
    ${tripList(state, escapeHtml)}
  </section>`;
}

function tripList(state, escapeHtml) {
  const now = Date.now();
  const trips = (state.events || []).filter((e) => e.kind === "leave" && new Date(e.start).getTime() > now - 3600000);
  if (!trips.length) return `<div class="empty">No leave reminders yet.</div>`;
  return trips
    .map((e) => {
      const t = new Date(e.start);
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      return `<article class="card tone-commute ${e.done ? "done" : ""}" data-id="${e.id}">
        <button class="check ${e.done ? "on" : ""}" data-check="${e.id}" aria-label="Mark complete"></button>
        <div>
          <div class="tag">Leave</div>
          <h3>${escapeHtml(e.title)}</h3>
          <p>${hh}:${mm}${e.alarm !== false ? " · alarm 10 min before" : ""}</p>
          ${e.notes ? `<p>${escapeHtml(e.notes)}</p>` : ""}
          <div class="card-actions">
            <button type="button" class="btn small" data-edit="${e.id}">Edit</button>
            <button type="button" class="btn small danger" data-remove="${e.id}">Remove</button>
          </div>
        </div>
      </article>`;
    })
    .join("");
}

export function placeSheetHtml(sh, { escapeHtml, escapeAttr }) {
  const p = sh.place || {};
  return `<div class="sheet" id="sheet"><div class="panel place-panel">
    <h2>Add location</h2>
    <p class="muted">Search a name, tap the map, or use GPS — no need to type the full street.</p>
    <div id="placeMap" class="travel-map place-map"></div>
    <label class="field">Search
      <input id="pSearch" value="${escapeAttr(p.name || "")}" placeholder="Star Market, Equinox, mosque…" autocomplete="off">
    </label>
    <div id="pHits" class="hits"></div>
    <div class="row" style="margin:4px 0 8px">
      <button type="button" class="btn small" id="pGps">Use GPS here</button>
    </div>
    <label class="field">Purpose
      <select id="pPurpose">${PURPOSES.map(
        (x) => `<option value="${x.id}" ${p.purpose === x.id ? "selected" : ""}>${x.label}</option>`
      ).join("")}</select>
    </label>
    <label class="field">Name <input id="pName" value="${escapeAttr(p.name || "")}" placeholder="Star Market"></label>
    <label class="field">Address <input id="pAddr" value="${escapeAttr(p.address || "")}" placeholder="Fills in when you pick a result"></label>
    <input type="hidden" id="pLat" value="${p.lat ?? ""}">
    <input type="hidden" id="pLng" value="${p.lng ?? ""}">
    <div class="row" style="margin-top:12px">
      <button class="btn primary" id="savePlace">Save place</button>
      <button class="btn ghost" id="closeSheet">Close</button>
    </div>
  </div></div>`;
}

let placeMap = null;
let placePin = null;

export function destroyPlaceMap() {
  if (placeMap) {
    placeMap.remove();
    placeMap = null;
    placePin = null;
  }
}

function setPin(lat, lng) {
  if (!placeMap || typeof L === "undefined") return;
  if (placePin) placeMap.removeLayer(placePin);
  placePin = L.circleMarker([lat, lng], { radius: 10, color: "#c63a68", fillColor: "#e45d88", fillOpacity: 1 }).addTo(placeMap);
  placeMap.setView([lat, lng], Math.max(placeMap.getZoom(), 15));
}

function fillPicked(hit) {
  const name = document.getElementById("pName");
  const addr = document.getElementById("pAddr");
  const lat = document.getElementById("pLat");
  const lng = document.getElementById("pLng");
  if (!addr || !lat) return;
  if (name && !name.value.trim()) name.value = hit.name || "";
  addr.value = hit.address || "";
  lat.value = String(hit.lat);
  lng.value = String(hit.lng);
  setPin(hit.lat, hit.lng);
}

export function bindPlaceSheet(root, { haptic }) {
  const el = document.getElementById("placeMap");
  if (!el || typeof L === "undefined") return;
  destroyPlaceMap();
  const start = { lat: 42.3468, lng: -71.1039 };
  placeMap = L.map(el, { zoomControl: true, attributionControl: false }).setView([start.lat, start.lng], 15);
  quietTiles(placeMap);
  setTimeout(() => placeMap?.invalidateSize(), 80);
  placeMap.on("click", async (e) => {
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    setPin(lat, lng);
    document.getElementById("pLat").value = String(lat);
    document.getElementById("pLng").value = String(lng);
    try {
      const hit = await reverseGeocode(lat, lng);
      if (hit) fillPicked(hit);
      else document.getElementById("pAddr").value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      haptic("light");
    } catch {
      document.getElementById("pAddr").value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }
  });

  let timer = 0;
  const search = document.getElementById("pSearch");
  const hitsBox = document.getElementById("pHits");
  search?.addEventListener("input", () => {
    clearTimeout(timer);
    const q = search.value.trim();
    if (q.length < 2) {
      hitsBox.innerHTML = "";
      return;
    }
    timer = setTimeout(async () => {
      try {
        const hits = await searchPlaces(q, 5);
        if (!hits.length) {
          hitsBox.innerHTML = `<p class="muted">No matches. Try a place name plus Boston, or tap the map.</p>`;
          return;
        }
        hitsBox.innerHTML = hits
          .map(
            (h, i) =>
              `<button type="button" class="hit" data-hit="${i}">${escapeMini(h.name)}<span>${escapeMini(h.address)}</span></button>`
          )
          .join("");
        hitsBox.querySelectorAll("[data-hit]").forEach((btn) =>
          btn.addEventListener("click", () => {
            fillPicked(hits[Number(btn.dataset.hit)]);
            hitsBox.innerHTML = "";
            haptic("success");
          })
        );
      } catch {
        hitsBox.innerHTML = `<p class="muted">Search needs internet. Tap the map instead.</p>`;
      }
    }, 450);
  });

  document.getElementById("pGps")?.addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        try {
          const hit = await reverseGeocode(lat, lng);
          fillPicked(hit || { lat, lng, name: "Here", address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
        } catch {
          fillPicked({ lat, lng, name: "Here", address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
        }
        haptic("success");
      },
      () => {
        hitsBox.innerHTML = `<p class="muted">Allow location, or tap the map.</p>`;
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

function escapeMini(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function bindPicks(root, ctx) {
  const { ui, haptic, render } = ctx;
  const closeAll = () => {
    root.querySelectorAll(".pick").forEach((p) => p.classList.remove("open"));
    root.querySelectorAll(".pick-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
  };
  root.querySelectorAll("[data-pick]").forEach((pick) => {
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
    pick.querySelectorAll(".pick-opt").forEach((opt) =>
      opt.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const val = opt.dataset.val ?? "";
        if (!val) return;
        if (pick.dataset.pick === "from") ui.travel.fromId = val;
        else ui.travel.toId = val;
        ui.travel.preview = null;
        closeAll();
        haptic("light");
        render();
      })
    );
  });
}

export async function bindMap(root, ctx) {
  const { state, ui, save, haptic, render, uid } = ctx;
  root.querySelectorAll("[data-purpose]").forEach((el) =>
    el.addEventListener("click", () => {
      ui.travel.purpose = el.dataset.purpose;
      const d = defaultsForPurpose(ui.travel.purpose, state.places);
      ui.travel.fromId = d.fromId;
      ui.travel.toId = d.toId;
      ui.travel.preview = null;
      ui.travel.error = "";
      haptic("light");
      if (!d.toId) {
        ui.sheet = {
          type: "place",
          place: { purpose: ui.travel.purpose, name: purposeLabel(ui.travel.purpose), address: "" },
        };
      }
      render();
    })
  );
  root.querySelectorAll("[data-mode]").forEach((el) =>
    el.addEventListener("click", () => {
      ui.travel.mode = el.dataset.mode;
      ui.travel.preview = null;
      render();
    })
  );
  bindPicks(root, ctx);
  root.querySelector("#trLeave")?.addEventListener("change", (e) => {
    ui.travel.leaveAt = new Date(e.target.value);
  });
  root.querySelector("#trHere")?.addEventListener("click", () => locate(ctx));
  root.querySelector("#trAddPlace")?.addEventListener("click", () => {
    ui.sheet = {
      type: "place",
      place: { purpose: ui.travel.purpose, name: purposeLabel(ui.travel.purpose), address: "" },
    };
    render();
  });
  root.querySelector("#trGpsDest")?.addEventListener("click", () => saveGpsAsDest(ctx));
  root.querySelector("#trRoute")?.addEventListener("click", () => runRoute(ctx));
  root.querySelector("#trAlarm")?.addEventListener("click", () => setAlarm(ctx));
  root.querySelectorAll("[data-del-place]").forEach((el) =>
    el.addEventListener("click", async () => {
      if (el.dataset.delPlace === "place_home" || el.dataset.delPlace === "place_office") {
        if (!confirm("Remove this saved place?")) return;
      }
      state.places = state.places.filter((p) => p.id !== el.dataset.delPlace);
      await save();
      render();
    })
  );
  paintMap(state, ui);
  refreshCoords(state, save);
}

async function saveGpsAsDest(ctx) {
  const { state, ui, save, haptic, render, uid } = ctx;
  if (!navigator.geolocation) {
    ui.travel.error = "GPS is not available on this device.";
    render();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      let hit = { lat, lng, name: purposeLabel(ui.travel.purpose), address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
      try {
        hit = (await reverseGeocode(lat, lng)) || hit;
      } catch {
        /* keep coords */
      }
      const place = {
        id: uid("place"),
        purpose: ui.travel.purpose,
        name: hit.name || purposeLabel(ui.travel.purpose),
        address: hit.address,
        lat,
        lng,
      };
      state.places.push(place);
      ui.travel.fromId = state.places.find((p) => p.purpose === "home")?.id || ui.travel.fromId;
      ui.travel.toId = place.id;
      ui.travel.preview = null;
      haptic("success");
      await save();
      render();
    },
    () => {
      ui.travel.error = "Allow location, or tap Add gym and search / tap the map.";
      render();
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function locate(ctx) {
  const { ui, haptic, render } = ctx;
  if (!navigator.geolocation) {
    ui.travel.error = "GPS is not available on this device.";
    render();
    return;
  }
  ui.travel.error = "";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      ui.travel.here = { lat: pos.coords.latitude, lng: pos.coords.longitude, name: "Current location" };
      ui.travel.fromId = "here";
      haptic("success");
      render();
    },
    () => {
      ui.travel.error = "Allow location to use Current location as the start.";
      render();
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function refreshCoords(state, save) {
  let changed = false;
  for (const p of state.places || []) {
    if (p.lat != null && p.lng != null) continue;
    try {
      const pt = await geocode(p.address);
      if (pt) {
        p.lat = pt.lat;
        p.lng = pt.lng;
        changed = true;
      }
    } catch {
      /* keep seed / skip */
    }
  }
  if (changed) await save();
}

async function runRoute(ctx) {
  const { state, ui, render, haptic } = ctx;
  const leaveEl = document.getElementById("trLeave");
  if (leaveEl?.value) ui.travel.leaveAt = new Date(leaveEl.value);
  const from = coordOf(ui.travel.fromId, state.places, ui.travel.here);
  const to = coordOf(ui.travel.toId, state.places, null);
  if (ui.travel.fromId === "here" && !from) {
    ui.travel.error = "Tap Use GPS first, or start from Home.";
    render();
    return;
  }
  if (!from || !to) {
    ui.travel.error = "Add a location for this purpose, then try again.";
    render();
    return;
  }
  ui.travel.error = "";
  haptic("medium");
  try {
    if (to.lat == null) {
      const pt = await geocode(to.address);
      if (pt) {
        const p = state.places.find((x) => x.id === ui.travel.toId);
        if (p) Object.assign(p, pt);
        to.lat = pt.lat;
        to.lng = pt.lng;
      }
    }
    const r = await routeBetween(from, to, ui.travel.mode);
    const leave = ui.travel.leaveAt instanceof Date ? ui.travel.leaveAt : new Date(ui.travel.leaveAt);
    const arriveAt = new Date(leave.getTime() + r.min * 60000);
    const hh = String(arriveAt.getHours()).padStart(2, "0");
    const mm = String(arriveAt.getMinutes()).padStart(2, "0");
    ui.travel.preview = {
      ...r,
      fromName: from.name || "Start",
      toName: to.name || "Destination",
      from,
      to,
      mode: ui.travel.mode,
      maps: mapsUrl(to, ui.travel.mode),
      arrive: `${hh}:${mm}`,
    };
  } catch {
    ui.travel.error = "Could not reach the map service. Check connection and retry.";
  }
  render();
}

async function setAlarm(ctx) {
  const { state, ui, save, syncAll, haptic, render, uid, isoDate } = ctx;
  const p = ui.travel.preview;
  if (!p) return;
  const leave = ui.travel.leaveAt instanceof Date ? ui.travel.leaveAt : new Date(ui.travel.leaveAt);
  if (leave.getTime() <= Date.now()) {
    ui.travel.error = "Pick a leave time in the future.";
    render();
    return;
  }
  const purpose = PURPOSES.find((x) => x.id === ui.travel.purpose)?.label || "trip";
  const title = `Leave for ${purpose}`;
  const dup = (state.events || []).some(
    (e) => e.kind === "leave" && e.title === title && Math.abs(new Date(e.start) - leave) < 60000
  );
  if (dup) {
    ui.travel.error = "That leave alarm is already on the list.";
    render();
    return;
  }
  state.events.push({
    id: uid("leave"),
    title,
    category: "commute",
    kind: "leave",
    start: leave.toISOString(),
    end: new Date(leave.getTime() + p.min * 60000).toISOString(),
    date: isoDate(leave),
    done: false,
    alarm: true,
    source: "user",
    notes: `${p.km.toFixed(1)} km · ${p.min} min ${ui.travel.mode} · arrive ${p.arrive}`,
    subtitle: p.toName,
  });
  haptic("success");
  await save();
  await syncAll(state, "leave-alarm-set");
  ui.travel.error = "";
  render();
}

function quietTiles(map) {
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    subdomains: "abcd",
    attribution: "OSM · CARTO",
  }).addTo(map);
}

function pinIcon(label, kind) {
  const safe = String(label || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .slice(0, 24);
  return L.divIcon({
    className: `pin pin-${kind}`,
    html: `<span>${safe}</span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

function paintMap(state, ui) {
  destroyMap();
  const el = document.getElementById("travelMap");
  if (!el || typeof L === "undefined") return;
  const from = coordOf(ui.travel.fromId, state.places, ui.travel.here);
  const to = coordOf(ui.travel.toId, state.places, null);
  const preview = ui.travel.preview;
  const start = from || { lat: 42.3468, lng: -71.1039, name: "Home" };
  liveMap = L.map(el, {
    zoomControl: true,
    attributionControl: false,
    zoomSnap: 0.5,
  });
  quietTiles(liveMap);
  const bounds = [];
  if (from) {
    L.marker([from.lat, from.lng], { icon: pinIcon(from.name || "Start", "from"), keyboard: false }).addTo(liveMap);
    bounds.push([from.lat, from.lng]);
  }
  if (to) {
    L.marker([to.lat, to.lng], { icon: pinIcon(to.name || "To", "to"), keyboard: false }).addTo(liveMap);
    bounds.push([to.lat, to.lng]);
  }
  const geom = preview?.geometry?.coordinates;
  if (geom?.length) {
    const latlngs = geom.map(([lng, lat]) => [lat, lng]);
    L.polyline(latlngs, { color: "#c63a68", weight: 5, opacity: 0.9, lineJoin: "round" }).addTo(liveMap);
  } else if (from && to) {
    L.polyline(
      [
        [from.lat, from.lng],
        [to.lat, to.lng],
      ],
      { color: "#c63a68", weight: 3, opacity: 0.55, dashArray: "6 8" }
    ).addTo(liveMap);
  }
  const fit = () => {
    if (!liveMap) return;
    liveMap.invalidateSize();
    if (bounds.length >= 2) {
      liveMap.fitBounds(bounds, { padding: [48, 48], maxZoom: 16 });
    } else {
      liveMap.setView([start.lat, start.lng], 15);
    }
  };
  fit();
  setTimeout(fit, 120);
  setTimeout(fit, 400);
}
