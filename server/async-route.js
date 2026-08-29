/**
 * Express 4 does not catch rejections from async handlers: the request hangs and
 * the process logs an unhandled rejection. Wrapping forwards the error to the
 * error middleware instead.
 */
export function asyncRoute(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Terminal handler: log the detail, tell the client nothing about the host. */
export function jsonErrorHandler(err, req, res, _next) {
  const status = Number(err?.status || err?.statusCode) || 500;
  console.error(`${req.method} ${req.path} failed:`, err?.stack || err?.message || err);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({
    ok: false,
    error: status === 400 ? "bad-request" : "server-error",
  });
}
