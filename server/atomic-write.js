import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Serialized atomic JSON writes.
 *
 * A single fixed `.tmp` path breaks under concurrency: parallel writers clobber
 * each other's temp file and every rename but one fails with ENOENT. Each write
 * therefore gets a unique temp name, and writes to the same destination are
 * queued so the last caller wins instead of racing.
 */

/** destination path -> tail of the write chain */
const queues = new Map();

const STALE_TEMP_MS = 5 * 60 * 1000;

function enqueue(key, task) {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  const settled = run.then(
    () => {},
    () => {}
  );
  queues.set(key, settled);
  settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

export function writeJsonAtomic(file, data) {
  return enqueue(file, () => writeJsonNow(file, data));
}

/**
 * Unqueued write. Use only from inside an existing `withFileLock` on the same
 * path — going through writeJsonAtomic there would deadlock on itself.
 */
export async function writeJsonNow(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return file;
}

/** Serializes non-write work against the same destination, e.g. read-modify-write. */
export function withFileLock(file, task) {
  return enqueue(file, task);
}

/**
 * Removes temp files left behind by a killed process. Only touches temps
 * belonging to the given destination, and only once they are demonstrably old.
 */
export async function cleanupStaleTemps(file, maxAgeMs = STALE_TEMP_MS, now = Date.now()) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const full = path.join(dir, name);
    try {
      const st = await stat(full);
      if (now - st.mtimeMs < maxAgeMs) continue;
      await rm(full, { force: true });
      removed++;
    } catch {
      /* vanished underneath us */
    }
  }
  return removed;
}

export function pendingWriteCount() {
  return queues.size;
}
