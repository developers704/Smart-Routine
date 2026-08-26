import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../client/shared/defaults.js";
import { DEFAULT_PLACES, ensurePlaces } from "../client/shared/travel.js";
import { isoDate } from "../client/shared/time.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "data", "db.json");

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
    const raw = await readFile(file, "utf8");
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
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await writeFile(file, JSON.stringify(state, null, 2), "utf8");
}
