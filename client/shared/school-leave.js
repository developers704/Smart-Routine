/** Walk-to-school alarm lead. Traffic minutes are added on top of the normal walk. */

export function schoolLeaveLead(walkMin = 10, trafficMin = 0) {
  const walk = Math.max(1, Math.round(Number(walkMin) || 10));
  const traffic = Math.max(0, Math.round(Number(trafficMin) || 0));
  return { walkMin: walk, trafficMin: traffic, leadMin: walk + traffic };
}

/** A flat 15-minute buffer whenever the real-time route is slower than the normal walk — no rush, no extra time. */
export const RUSH_TRAFFIC_MIN = 15;

/** Router duration above the normal walk means rush on the roads. A faster route does not shrink the normal walk. */
export function trafficFromRoute(routeMin, normalWalkMin = 10) {
  const route = Math.max(1, Math.round(Number(routeMin) || normalWalkMin));
  const normal = Math.max(1, Math.round(Number(normalWalkMin) || 10));
  const rush = route > normal;
  return schoolLeaveLead(normal, rush ? RUSH_TRAFFIC_MIN : 0);
}

export function leaveAlarmAt(classStartMs, leadMin) {
  return classStartMs - Math.max(1, leadMin) * 60000;
}
