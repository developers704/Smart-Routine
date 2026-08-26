import { isNative, plugin } from "./native.js";

const fired = new Set();
/** iOS pending local-notification cap is 64. */
export const NATIVE_ALARM_CAP = 64;
const CHANNEL = "routine-alarms";

export async function ensurePermission() {
  const LocalNotifications = plugin("LocalNotifications");
  if (LocalNotifications) {
    try {
      await LocalNotifications.createChannel?.({
        id: CHANNEL,
        name: "Alarms",
        description: "Shift, meal, study, and notepad alerts",
        importance: 5,
        visibility: 1,
        vibration: true,
        sound: "default",
      });
    } catch {
      /* web / older plugin */
    }
    await LocalNotifications.requestPermissions();
    return LocalNotifications;
  }
  if (!isNative() && typeof Notification !== "undefined" && Notification.permission === "default") {
    await Notification.requestPermission();
  }
  return null;
}

function subtitle(e) {
  const t = new Date(e.start);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}${e.subtitle ? " · " + e.subtitle : ""}`;
}

function nextNotepadAt(remindMin, now = Date.now()) {
  const d = new Date(now);
  d.setHours(Math.floor(remindMin / 60), remindMin % 60, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Lead ping (notification) + on-the-dot ping (alarm sound).
 * Offline: uses wall-clock Date, no server.
 */
export function buildNotificationPlan(state, now = Date.now()) {
  const leadMin = state.settings?.alarmLeadMin ?? 10;
  const leadMs = leadMin * 60 * 1000;
  const items = [];
  for (const e of state.events || []) {
    if (e.done || e.alarm === false) continue;
    const start = new Date(e.start).getTime();
    if (!Number.isFinite(start)) continue;
    const body = subtitle(e);
    if (leadMs > 0 && start - leadMs > now) {
      items.push({
        at: new Date(start - leadMs),
        title: e.title,
        body: `In ${leadMin} min · ${body}`,
        kind: "notify",
        eventId: e.id,
      });
    }
    if (start > now) {
      items.push({
        at: new Date(start),
        title: e.title,
        body: `Now · ${body}`,
        kind: "alarm",
        eventId: e.id,
      });
    }
  }
  const openNotes = (state.notes || []).filter((n) => !n.converted && String(n.text || "").trim());
  if (openNotes.length) {
    const remindMin = state.settings?.notepadRemindMin ?? 21 * 60 + 30;
    items.push({
      at: nextNotepadAt(remindMin, now),
      title: "End of day — notepad",
      body: openNotes.map((n) => n.text).slice(0, 4).join(" · "),
      kind: "notepad",
      eventId: "notepad",
    });
  }
  items.sort((a, b) => a.at - b.at || (a.kind === "alarm" ? 1 : -1));
  return items.slice(0, NATIVE_ALARM_CAP);
}

export function tickAlarms(state) {
  if (!state || isNative()) return;
  const now = Date.now();
  const lead = (state.settings?.alarmLeadMin ?? 10) * 60000;
  for (const e of state.events || []) {
    if (e.done || e.alarm === false) continue;
    const start = new Date(e.start).getTime();
    const windows = [
      ["lead", start - lead, start - lead + 60000],
      ["start", start, start + 60000],
    ];
    for (const [tag, from, to] of windows) {
      if (now < from || now >= to) continue;
      const key = `${e.id}:${e.start}:${tag}`;
      if (fired.has(key)) continue;
      fired.add(key);
      notify(e.title, tag === "lead" ? `In ${state.settings?.alarmLeadMin ?? 10} min · ${subtitle(e)}` : `Now · ${subtitle(e)}`);
    }
  }
  const remindMin = state.settings?.notepadRemindMin ?? 21 * 60 + 30;
  const d = new Date();
  const mins = d.getHours() * 60 + d.getMinutes();
  const openNotes = (state.notes || []).filter((n) => !n.converted && n.text.trim());
  if (openNotes.length && Math.abs(mins - remindMin) <= 1) {
    const key = `notes:${d.toDateString()}`;
    if (!fired.has(key)) {
      fired.add(key);
      notify("End of day — notepad", openNotes.map((n) => n.text).slice(0, 4).join(" · "));
    }
  }
}

function notify(title, body) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (navigator.serviceWorker?.ready) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, { body, icon: "/icons/icon.svg" }));
  } else {
    new Notification(title, { body });
  }
}

export async function scheduleNative(state, LocalNotifications) {
  const api = LocalNotifications || plugin("LocalNotifications");
  if (!api) return;
  try {
    const pending = await api.getPending();
    if (pending.notifications?.length) {
      await api.cancel({ notifications: pending.notifications });
    }
  } catch {
    /* first launch */
  }
  const plan = buildNotificationPlan(state);
  const notifications = plan.map((p, i) => ({
    id: i + 1,
    title: p.title,
    body: p.body,
    extra: { kind: p.kind, eventId: p.eventId },
    channelId: CHANNEL,
    schedule: { at: p.at, allowWhileIdle: true },
    sound: "default",
  }));
  if (!notifications.length) return;
  try {
    await api.schedule({ notifications });
  } catch {
    for (const n of notifications) {
      try {
        await api.schedule({ notifications: [n] });
      } catch {
        /* skip one past/invalid fire time */
      }
    }
  }
}
