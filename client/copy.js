export const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEK_HD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const TONE = {
  sleep: "sleep",
  recovery: "recovery",
  work: "work",
  commute: "commute",
  meal: "meal",
  prayer: "prayer",
  study: "study",
  gym: "gym",
  chore: "chore",
  personal: "personal",
};

export const CAT = {
  sleep: "Sleep",
  recovery: "Recovery",
  work: "Shift",
  commute: "Commute",
  meal: "Meal",
  prayer: "JK",
  study: "MCAT",
  gym: "Gym",
  chore: "Chore",
  personal: "Personal",
};

export const DAD_WHATSAPP = {
  name: "Dad",
  href: "https://wa.me/14085643456",
};

export function needsDadCall(e) {
  const blob = `${e.notes || ""} ${e.subtitle || ""}`;
  return e.kind === "commute" || /call parents/i.test(blob);
}

export function prettyTitle(e) {
  if (e.kind === "work" || (e.title && e.title.startsWith("Shift "))) return "Hospital shift";
  return e.title || "Event";
}

export function prettyNotes(e) {
  const n = e.notes || "";
  if (!n || n === "Call parents") return "";
  if (n.includes("Mandatory")) return "";
  if (/^Transition\b/i.test(n) || n.includes("Sleep capped") || n.includes("Protect the next")) return "";
  return n;
}

export function prettyWarn(text) {
  return text || "";
}

export function prettyDur(min) {
  const m = Math.round(min);
  if (m >= 60 && m % 60 === 0) return `${m / 60}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m} min`;
}
