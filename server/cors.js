/** Capacitor WKWebView origins that call the VPS family API. */
export const NATIVE_WEBVIEW_ORIGINS = [
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
  "ionic://localhost",
];

export function allowNativeCors(origin) {
  return NATIVE_WEBVIEW_ORIGINS.includes(String(origin || ""));
}

export function corsNative(req, res, next) {
  const origin = String(req.headers.origin || "");
  if (allowNativeCors(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS" && allowNativeCors(origin)) {
    res.status(204).end();
    return;
  }
  next();
}
