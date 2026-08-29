import { readFile } from "node:fs/promises";
import { DEFAULT_SETTINGS } from "../client/shared/defaults.js";
import { DEFAULT_PLACES, ensurePlaces } from "../client/shared/travel.js";
import { isoDate } from "../client/shared/time.js";
import { cleanupStaleTemps, writeJsonAtomic } from "./atomic-write.js";
import { dataFile } from "./paths.js";

function stateFile() {
  return dataFile("db.json");
}

function emptyState() {
  const today = isoDate(new Date());
  return {
    settings: { ...DEFAULT_SETTINGS },
    shifts: {},
    events: [],
    places: DEFAULT_PLACES.map((p) => ({ ...p })),
    notes: [
      {
        id: "welcome",
        text: "Pick a day, set M / M+A / E+N / N, and the rest of the day fills in. Add your own events anytime.",
        createdAt: new Date().toISOString(),
        converted: false,
      },
    ],
    generatedAt: null,
    todayHint: today,
  };
}

export async function loadState() {
  try {
    const raw = await readFile(stateFile(), "utf8");
    const data = JSON.parse(raw);
    return {
      ...emptyState(),
      ...data,
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
      places: ensurePlaces(data.places),
    };
  } catch {
    const state = emptyState();
    await saveState(state);
    return state;
  }
}

export async function saveState(state) {
  await writeJsonAtomic(stateFile(), state);
}

export function stateFilePath() {
  return stateFile();
}

export function cleanupStateTemps(maxAgeMs) {
  return cleanupStaleTemps(stateFile(), maxAgeMs);
}
