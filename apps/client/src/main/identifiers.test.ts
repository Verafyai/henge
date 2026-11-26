import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEME } from './deeplinks';
import { DEFAULT_KEYCHAIN_SERVICE } from './secrets';
import { APP_ORIGIN } from './security';

/**
 * The identifiers are final before signing (DECISIONS, finish-up brief 2026-11-25). Changing any of them after a
 * signed release strands users' keychain entries and deep links, so they are pinned here in one place.
 */
const APP_ID = 'ai.verafy.henge';

describe('app identifiers', () => {
  const builder = readFileSync(path.resolve(__dirname, '../../electron-builder.yml'), 'utf8');

  it('use ai.verafy.henge, henge:// and app://henge everywhere', () => {
    expect(builder).toMatch(/^appId: ai\.verafy\.henge$/m);
    expect(builder).toMatch(/schemes: \[henge\]/);
    expect(SCHEME).toBe('henge');
    expect(DEFAULT_KEYCHAIN_SERVICE).toBe(APP_ID);
    expect(APP_ORIGIN).toBe('app://henge');
  });

  it('leave no old Swarm Explorer identifiers in the client or the README', () => {
    const readme = readFileSync(path.resolve(__dirname, '../../../../README.md'), 'utf8');
    for (const text of [builder, readme]) {
      expect(text).not.toMatch(/swarmexplorer|ai\.verafy\.swarm/i);
    }
  });
});
