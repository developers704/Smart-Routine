/**
 * Boots the real server the way production does and talks to it over HTTP.
 *
 * Unit tests import modules directly, so they never catch a missing runtime
 * dependency or a broken import graph — `dotenv` was absent from package.json
 * and every unit test still passed while `npm start` died on a fresh install.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4100 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = await mkdtemp(path.join(tmpdir(), "routine-smoke-"));

const child = spawn(process.execPath, [path.join(root, "server", "index.js")], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    ROUTINE_DATA_DIR: dataDir,
    VAPID_PUBLIC_KEY: "",
    VAPID_PRIVATE_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  stdout += d.toString();
});
child.stderr.on("data", (d) => {
  stderr += d.toString();
});

let exited = null;
child.on("exit", (code) => {
  exited = code;
});

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) return { ok: false, reason: `process exited with ${exited}` };
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return { ok: true, status: res.status, body: await res.json() };
      return { ok: false, reason: `status ${res.status}` };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return { ok: false, reason: "timed out" };
}

const health = await waitForHealth();
assert(
  health.ok,
  `Server starts and answers /api/health${health.ok ? "" : ` — ${health.reason}\n${stderr.trim()}`}`
);
assert(health.status === 200, `Health check returns HTTP 200 (got ${health.status})`);
assert(health.body?.ok === true, "Health check body reports ok");
assert(!/ERR_MODULE_NOT_FOUND/.test(stderr), "No missing-module error on startup");
assert(stdout.includes("Routine running"), "Server logs its listening line");

if (health.ok) {
  const state = await fetch(`${BASE}/api/state`);
  assert(state.status === 200, `State endpoint answers (got ${state.status})`);
  const body = await state.json();
  assert(Boolean(body.settings), "State response carries settings");

  const created = await readdir(dataDir);
  assert(created.includes("db.json"), `State is written to the temporary data dir (saw ${created.join(", ") || "nothing"})`);

  const vapid = await fetch(`${BASE}/api/push/vapid-public-key`);
  assert(vapid.status === 200, "VAPID endpoint answers without keys configured");
  assert((await vapid.json()).publicKey === "", "VAPID key is empty when unconfigured");

  const pushStatus = await fetch(`${BASE}/api/push/status`).then((r) => r.json());
  assert(pushStatus.configured === false, "Push reports itself unconfigured");

  const badSub = await fetch(`${BASE}/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: "http://not-https/x" }),
  });
  assert(badSub.status === 503, `Subscribing without VAPID is refused (got ${badSub.status})`);

  const verify = await fetch(`${BASE}/api/push/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: "https://push.example/unknown" }),
  }).then((r) => r.json());
  assert(verify.registered === false, "Verify reports an unknown endpoint as unregistered");

  const badState = await fetch(`${BASE}/api/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([]),
  });
  assert(badState.status === 400, `A non-object state body is rejected (got ${badState.status})`);

  const index = await fetch(`${BASE}/`);
  assert(index.status === 200, "The PWA index is served");
  const html = await index.text();
  assert(html.includes("Smart Routine"), "Index HTML is the app shell");

  for (const asset of ["/app.js", "/routine-alarms.js", "/shared/alarm-plan.js", "/shared/tz.js"]) {
    const res = await fetch(`${BASE}${asset}`);
    assert(res.status === 200, `${asset} is served`);
  }

  assert(health.body?.pushReady === true, "Push state is loaded before the server listens");
  const status = await fetch(`${BASE}/api/push/status`).then((r) => r.json());
  assert(status.ready === true, "Push status reports readiness");
}

// --- filesystem failures return 500, not a hang or an unhandled rejection --
// Express 4 does not catch async handler rejections on its own.
const blockedDir = path.join(await mkdtemp(path.join(tmpdir(), "routine-blocked-")), "not-a-dir");
await writeFile(blockedDir, "this is a file, so mkdir must fail", "utf8");

const brokenPort = PORT + 1;
const brokenBase = `http://127.0.0.1:${brokenPort}`;
const broken = spawn(process.execPath, [path.join(root, "server", "index.js")], {
  cwd: root,
  env: { ...process.env, PORT: String(brokenPort), ROUTINE_DATA_DIR: blockedDir, VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let brokenErr = "";
broken.stderr.on("data", (d) => {
  brokenErr += d.toString();
});

let brokenUp = false;
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`${brokenBase}/api/health`);
    if (res.ok) {
      brokenUp = true;
      break;
    }
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
assert(brokenUp, "The server still starts when its data directory is unusable");

if (brokenUp) {
  const put = await Promise.race([
    fetch(`${brokenBase}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: {}, events: [] }),
    }),
    new Promise((r) => setTimeout(() => r({ timeout: true }), 6000)),
  ]);
  assert(!put.timeout, "A failing write answers instead of hanging the request");
  if (!put.timeout) {
    assert(put.status === 500, `A failing write returns HTTP 500 (got ${put.status})`);
    const body = await put.json().catch(() => ({}));
    assert(body.error === "server-error", `The response is a generic error (got ${JSON.stringify(body)})`);
    const serialized = JSON.stringify(body);
    assert(!serialized.includes(blockedDir), "The response does not leak the data path");
    assert(!/ENOTDIR|EEXIST|ENOENT|\/tmp\//.test(serialized), "The response does not leak filesystem detail");
  }

  const get = await Promise.race([
    fetch(`${brokenBase}/api/state`),
    new Promise((r) => setTimeout(() => r({ timeout: true }), 6000)),
  ]);
  assert(!get.timeout, "A failing read answers instead of hanging");
  assert(get.status === 500, `A failing read returns HTTP 500 (got ${get.status})`);

  const stillAlive = await fetch(`${brokenBase}/api/health`);
  assert(stillAlive.ok, "The server survives the failures");
  assert(!/UnhandledPromiseRejection/.test(brokenErr), "No unhandled rejection was raised");
  assert(/failed:/.test(brokenErr), "The failure is logged server-side");
}

broken.kill("SIGTERM");
await rm(path.dirname(blockedDir), { recursive: true, force: true });

// --- clean shutdown -------------------------------------------------------
const closed = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
child.kill("SIGTERM");
const stop = await Promise.race([
  closed,
  new Promise((r) => setTimeout(() => r({ timeout: true }), 5000)),
]);
if (stop.timeout) {
  child.kill("SIGKILL");
  assert(false, "Server did not exit within 5s of SIGTERM");
} else {
  assert(true, `Server exits on SIGTERM (signal ${stop.signal || stop.code})`);
}

await rm(dataDir, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} server smoke check(s) failed`);
  process.exit(1);
}
console.log("\nAll server smoke checks passed");
