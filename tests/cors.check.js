import { allowNativeCors, corsNative, NATIVE_WEBVIEW_ORIGINS } from "../server/cors.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

assert(NATIVE_WEBVIEW_ORIGINS.includes("https://localhost"), "Capacitor iOS WKWebView origin is allowed");
assert(!allowNativeCors("https://evil.example"), "Unknown origins do not get CORS");

function run(method, origin) {
  const headers = {};
  const req = { method, headers: origin ? { origin } : {} };
  const res = {
    statusCode: 200,
    bodyEnded: false,
    setHeader(k, v) {
      headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.bodyEnded = true;
    },
  };
  let nextCalled = false;
  corsNative(req, res, () => {
    nextCalled = true;
  });
  return { headers, res, nextCalled };
}

{
  const out = run("OPTIONS", "https://localhost");
  assert(out.headers["Access-Control-Allow-Origin"] === "https://localhost", "Preflight echoes the native origin");
  assert(out.headers["Access-Control-Allow-Headers"].includes("Authorization"), "Preflight allows the session header");
  assert(out.res.statusCode === 204 && out.res.bodyEnded && !out.nextCalled, "Native OPTIONS is answered without routing");
}

{
  const out = run("POST", "https://localhost");
  assert(out.headers["Access-Control-Allow-Origin"] === "https://localhost", "POST from the iPhone webview is allowed");
  assert(out.nextCalled, "Non-OPTIONS requests continue to the login route");
}

{
  const out = run("OPTIONS", "https://evil.example");
  assert(!out.headers["Access-Control-Allow-Origin"], "Evil origin gets no CORS header");
  assert(out.nextCalled, "Unknown OPTIONS is not short-circuited as native");
}

if (failed) {
  console.error(`\n${failed} cors check(s) failed`);
  process.exit(1);
}
console.log("\nAll cors checks passed");
