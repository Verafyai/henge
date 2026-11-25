/**
 * Disk budget (SPEC 5.4): when a download would exceed the budget, offer the least-used models for
 * removal. A model that is active, in use, or required by a lease is never offered, and nothing is
 * removed here; the user confirms each removal.
 */
export type InstalledForDisk = {
  contentHash: string;
  sizeBytes: number;
  lastUsedAt: number | null;
  installedAt: number;
  /** Only models Swarm Explorer downloaded can be removed by it. Pre-existing runtime models are the user's. */
  managed: boolean;
};

export type DiskPlan =
  | { ok: true; usedBytes: number; afterBytes: number }
  | { ok: false; reason: 'no_budget' }
  | { ok: false; reason: 'larger_than_budget'; usedBytes: number }
  | { ok: false; reason: 'over_budget'; usedBytes: number; needBytes: number; suggestions: string[]; protectedHashes: string[] };

export function usedBytes(installed: readonly InstalledForDisk[]): number {
  return installed.filter((m) => m.managed).reduce((n, m) => n + m.sizeBytes, 0);
}

/**
 * `protect` holds every hash that must stay: the active model plus anything in use or leased.
 * Suggestions are the least recently used removable models, just enough to make room.
 */
export function planDownload(installed: readonly InstalledForDisk[], budgetBytes: number | null, sizeBytes: number, protect: ReadonlySet<string>): DiskPlan {
  if (budgetBytes === null) return { ok: false, reason: 'no_budget' };
  const used = usedBytes(installed);
  if (sizeBytes > budgetBytes) return { ok: false, reason: 'larger_than_budget', usedBytes: used };
  if (used + sizeBytes <= budgetBytes) return { ok: true, usedBytes: used, afterBytes: used + sizeBytes };
  const needBytes = used + sizeBytes - budgetBytes;
  const removable = installed
    .filter((m) => m.managed && !protect.has(m.contentHash))
    .sort((a, b) => (a.lastUsedAt ?? a.installedAt) - (b.lastUsedAt ?? b.installedAt));
  const suggestions: string[] = [];
  let freed = 0;
  for (const m of removable) {
    if (freed >= needBytes) break;
    suggestions.push(m.contentHash);
    freed += m.sizeBytes;
  }
  return {
    ok: false,
    reason: 'over_budget',
    usedBytes: used,
    needBytes,
    // When even removing every removable model is not enough, nothing is suggested.
    suggestions: freed >= needBytes ? suggestions : [],
    protectedHashes: installed.filter((m) => protect.has(m.contentHash)).map((m) => m.contentHash),
  };
}

/** Guard for every removal path. */
export function canRemove(contentHash: string, installed: readonly InstalledForDisk[], protect: ReadonlySet<string>): { ok: true } | { ok: false; reason: 'protected' | 'not_managed' | 'not_installed' } {
  const m = installed.find((x) => x.contentHash === contentHash);
  if (!m) return { ok: false, reason: 'not_installed' };
  if (!m.managed) return { ok: false, reason: 'not_managed' };
  if (protect.has(contentHash)) return { ok: false, reason: 'protected' };
  return { ok: true };
}
