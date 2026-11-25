/**
 * Central permission checks: every authorization decision goes through
 * `can(actor, action, resource)`. Actions grow with the SPEC 2.2 roles matrix
 * milestone by milestone: M0 covers account and install actions, M1 adds node reports.
 */
export type Actor = { id: string; isAdmin?: boolean; suspendedAt?: Date | null } | null;

type Owned = { accountId: string };

export type PolicyResource = {
  'account.read': Owned;
  'install.list': Owned;
  'install.revoke': Owned & { revokedAt: Date | null };
  'install.register': Owned & { revokedAt: Date | null };
  /** A node reports only through the install it belongs to (SPEC 13.1). */
  'node.report': Owned & { installId: string; callerInstallId: string };
};

export type Action = keyof PolicyResource;

const rules: { [A in Action]: (u: NonNullable<Actor>, r: PolicyResource[A]) => boolean } = {
  'account.read': (u, r) => u.id === r.accountId,
  'install.list': (u, r) => u.id === r.accountId,
  // Owners revoke their own installs; platform admins may revoke any (SPEC 15.1 blocks compromised clients).
  'install.revoke': (u, r) => r.revokedAt === null && (u.id === r.accountId || Boolean(u.isAdmin)),
  'install.register': (u, r) => r.revokedAt === null && u.id === r.accountId,
  'node.report': (u, r) => u.id === r.accountId && r.installId === r.callerInstallId,
};

export function can<A extends Action>(user: Actor, action: A, resource: PolicyResource[A]): boolean {
  if (!user || user.suspendedAt) return false;
  return rules[action](user, resource);
}
