import { readFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, defaultShiftsForToday } from "../client/shared/defaults.js";
import { DEFAULT_PLACES, ensurePlaces } from "../client/shared/travel.js";
import { isoDate } from "../client/shared/time.js";
import { cleanupStaleTemps, writeJsonAtomic } from "./atomic-write.js";
import { dataFile } from "./paths.js";

function stateFile(userId) {
  if (!userId || userId === "user_anika") return dataFile("db.json");
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, "");
  return dataFile(`db-${safe}.json`);
}

function emptyState() {
  const today = isoDate(new Date());
  return {
    settings: { ...DEFAULT_SETTINGS },
    shifts: defaultShiftsForToday(),
    events: [],
    places: DEFAULT_PLACES.map((p) => ({ ...p })),
    notes: [
      {
        id: "welcome",
        text: "Pick a day, set M / M+A / E+N / N / Off — this week starts Mon–Tue off, Wed–Fri morning, Sat off, Sun M+A. Change any day and rebuild.",
        createdAt: new Date().toISOString(),
        converted: false,
      },
    ],
    generatedAt: null,
    todayHint: today,
  };
}

export async function loadState(userId) {
  try {
    const raw = await readFile(stateFile(userId), "utf8");
    const data = JSON.parse(raw);
    return {
      ...emptyState(),
      ...data,
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
      places: ensurePlaces(data.places),
    };
  } catch {
    const state = emptyState();
    if (userId && userId !== "user_anika") state.notes = [];
    await saveState(state, userId);
    return state;
  }
}

export async function saveState(state, userId) {
  await writeJsonAtomic(stateFile(userId), state);
}

export function stateFilePath(userId) {
  return stateFile(userId);
}

export function cleanupStateTemps(maxAgeMs) {
  return cleanupStaleTemps(stateFile(), maxAgeMs);
}
