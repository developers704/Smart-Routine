/**
 * Minimal fixed-window limiter. In-process only — enough to stop a single
 * client hammering the push endpoints, not a substitute for authentication.
 */
export function rateLimit({ max = 30, windowMs = 60_000, name = "route" } = {}) {
  const hits = new Map();
  return function limiter(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
    } else if (entry.count >= max) {
      const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({ ok: false, error: "rate-limited", route: name, retryAfter });
      return;
    } else {
      entry.count++;
    }
    if (hits.size > 1000) {
      for (const [k, v] of hits) {
        if (now - v.start >= windowMs) hits.delete(k);
      }
    }
    next();
  };
}
