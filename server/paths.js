import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where persisted state lives. Overridable so the smoke test can run against a
 * throwaway directory instead of the real database.
 */
export function dataDir() {
  const override = process.env.ROUTINE_DATA_DIR;
  return override ? path.resolve(override) : path.join(root, "data");
}

export function dataFile(name) {
  return path.join(dataDir(), name);
}

export function projectRoot() {
  return root;
}
