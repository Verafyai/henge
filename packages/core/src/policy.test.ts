import { describe, expect, it } from 'vitest';
import { can, type Actor } from './policy';

const owner: Actor = { id: 'u1' };
const stranger: Actor = { id: 'u2' };
const admin: Actor = { id: 'a1', isAdmin: true };
const banned: Actor = { id: 'u1', suspendedAt: new Date() };
const live = { accountId: 'u1', revokedAt: null };
const revoked = { accountId: 'u1', revokedAt: new Date() };

describe('can', () => {
  it.each([
    ['owner reads own account', owner, true],
    ['stranger reads account', stranger, false],
    ['signed out reads account', null, false],
    ['banned owner reads account', banned, false],
  ] as const)('%s', (_n, actor, expected) => {
    expect(can(actor, 'account.read', { accountId: 'u1' })).toBe(expected);
  });

  it.each([
    ['owner revokes own install', owner, live, true],
    ['stranger revokes install', stranger, live, false],
    ['admin revokes any install', admin, live, true],
    ['already revoked', owner, revoked, false],
  ] as const)('%s', (_n, actor, install, expected) => {
    expect(can(actor, 'install.revoke', install)).toBe(expected);
  });

  it('revoked installs cannot register, even for admins', () => {
    expect(can(owner, 'install.register', revoked)).toBe(false);
    expect(can(admin, 'install.register', live)).toBe(false);
  });
  it('a node reports only through its own install', () => {
    const node = { accountId: owner.id, installId: 'i1' };
    expect(can(owner, 'node.report', { ...node, callerInstallId: 'i1' })).toBe(true);
    expect(can(owner, 'node.report', { ...node, callerInstallId: 'i2' })).toBe(false);
    expect(can(admin, 'node.report', { ...node, callerInstallId: 'i1' })).toBe(false);
  });
});
