/** Walk-to-school alarm lead. Traffic minutes are added on top of the normal walk. */

export function schoolLeaveLead(walkMin = 10, trafficMin = 0) {
  const walk = Math.max(1, Math.round(Number(walkMin) || 10));
  const traffic = Math.max(0, Math.round(Number(trafficMin) || 0));
  return { walkMin: walk, trafficMin: traffic, leadMin: walk + traffic };
}

/** Router duration above the normal walk is the rush. A faster route does not shrink the normal walk. */
export function trafficFromRoute(routeMin, normalWalkMin = 10) {
  const route = Math.max(1, Math.round(Number(routeMin) || normalWalkMin));
  const normal = Math.max(1, Math.round(Number(normalWalkMin) || 10));
  return schoolLeaveLead(normal, Math.max(0, route - normal));
}

export function leaveAlarmAt(classStartMs, leadMin) {
  return classStartMs - Math.max(1, leadMin) * 60000;
}
