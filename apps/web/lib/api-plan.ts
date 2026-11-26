/**
 * SPEC 13 endpoints that are routed but not built yet. They answer 501 with the
 * milestone (SPEC 16.4) that delivers them, so the client and CLI can be written
 * against stable paths. Built endpoints have their own route handlers.
 */
export type PlannedRoute = { method: string; pattern: RegExp; path: string; milestone: string };

const r = (method: string, path: string, milestone: string): PlannedRoute => ({
  method,
  path,
  milestone,
  pattern: new RegExp(`^${path.replace(/\{[a-z_]+\}/g, '[^/]+')}$`),
});

export const PLANNED_ROUTES: PlannedRoute[] = [
  // 13.3 Task protocol (the lease endpoints are built in M5)
  r('GET', '/results/{id}', 'M7'),
  // 13.4 Ledger, publisher and admin
  r('POST', '/pools/{id}/donations', 'M9'),
  r('POST', '/jobs', 'M9'),
  r('POST', '/publishers', 'M9'),
  r('POST', '/publishers/{id}/verification', 'M9'),
  r('POST', '/publisher-keys', 'M11'),
  r('POST', '/swarm-releases', 'M11'),
  r('POST', '/publishers/{id}/credit-purchases', 'M9'),
  r('GET', '/publishers/{id}/dashboard', 'M9'),
  r('POST', '/admin/revocations', 'M7'),
];

export function matchPlanned(method: string, path: string): PlannedRoute | undefined {
  return PLANNED_ROUTES.find((p) => p.method === method && p.pattern.test(path));
}
