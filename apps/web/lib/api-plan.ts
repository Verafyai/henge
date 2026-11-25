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
  // 13.1 Node and catalog
  r('GET', '/store/home', 'M4'),
  // 13.2 Join and qualification
  r('POST', '/swarms/{id}/memberships', 'M4'),
  r('POST', '/memberships/{id}/permission-grants', 'M4'),
  r('POST', '/memberships/{id}/qualification/lease', 'M4'),
  r('POST', '/memberships/{id}/qualification/results', 'M4'),
  r('PATCH', '/nodes/{node_id}/shares', 'M5'),
  r('DELETE', '/memberships/{id}', 'M4'),
  // 13.3 Task protocol
  r('POST', '/coordinators/{swarm}/leases', 'M5'),
  r('POST', '/leases/{lease_id}/renew', 'M5'),
  r('POST', '/leases/{lease_id}/abandon', 'M5'),
  r('POST', '/leases/{lease_id}/results', 'M5'),
  r('GET', '/leases/{lease_id}', 'M5'),
  r('POST', '/verifications', 'M6'),
  r('GET', '/results/{id}', 'M7'),
  // 13.4 Ledger, publisher and admin
  r('GET', '/wallet', 'M6'),
  r('GET', '/ledger', 'M6'),
  r('POST', '/pools/{id}/donations', 'M9'),
  r('POST', '/jobs', 'M9'),
  r('POST', '/publishers', 'M9'),
  r('POST', '/publishers/{id}/verification', 'M9'),
  r('POST', '/publisher-keys', 'M11'),
  r('POST', '/swarm-releases', 'M11'),
  r('POST', '/publishers/{id}/credit-purchases', 'M9'),
  r('POST', '/swarms/{id}/tasks:batch', 'M5'),
  r('GET', '/publishers/{id}/dashboard', 'M9'),
  r('POST', '/admin/reviews/{id}', 'M4'),
  r('POST', '/admin/revocations', 'M7'),
];

export function matchPlanned(method: string, path: string): PlannedRoute | undefined {
  return PLANNED_ROUTES.find((p) => p.method === method && p.pattern.test(path));
}
