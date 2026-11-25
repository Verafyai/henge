import path from 'node:path';
import { repoRoot } from '@swarm-explorer/db';

/**
 * Local bundle host (development and tests): reviewed fixture bundles live in the repository.
 * Staging and production publish bundles to GitHub Releases instead (decision 2026-11-25).
 */
export function localBundleDir(name: string): string {
  return path.join(repoRoot(), 'packages', 'schema', 'fixtures', 'harnesses', name);
}
