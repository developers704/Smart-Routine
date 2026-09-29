import { readFile } from "node:fs/promises";
import { DEFAULT_SETTINGS } from "../client/shared/defaults.js";
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
    events: [],
    places: DEFAULT_PLACES.map((p) => ({ ...p })),
    notes: [
      {
        id: "welcome",
        text: "Tap Add event to put a class, sleep, or call-parent block on the day. Alarms, the wake quiz, and the leave-for-school reminder stay on automatically.",
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
