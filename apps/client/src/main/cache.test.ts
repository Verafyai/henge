import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { EncryptedCache } from './cache';
import { MemoryStore } from './secrets';

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), 'ss-cache-')), 'cache.db');

describe('EncryptedCache', () => {
  it('round trips values and keeps the key in the secret store', async () => {
    const secrets = new MemoryStore();
    const file = tmp();
    const c = await EncryptedCache.open(file, secrets);
    c.set('library', [{ slug: 'owr-remake', addedAt: 1 }]);
    expect(c.get('library')).toEqual([{ slug: 'owr-remake', addedAt: 1 }]);
    expect(secrets.map.get('cache-key')).toBeTruthy();
    c.close();
    const again = await EncryptedCache.open(file, secrets);
    expect(again.get('library')).toEqual([{ slug: 'owr-remake', addedAt: 1 }]);
    again.close();
  });

  it('writes no plaintext names or values to disk', async () => {
    const file = tmp();
    const c = await EncryptedCache.open(file, new MemoryStore());
    c.set('recently-viewed', ['a-very-recognizable-slug']);
    c.close();
    for (const f of readdirSync(path.dirname(file))) {
      const bytes = readFileSync(path.join(path.dirname(file), f)).toString('latin1');
      expect(bytes).not.toContain('a-very-recognizable-slug');
      expect(bytes).not.toContain('recently-viewed');
    }
  });

  it('returns null with the wrong key or tampered rows', async () => {
    const file = tmp();
    const c = await EncryptedCache.open(file, new MemoryStore());
    c.set('x', { a: 1 });
    c.close();
    const other = await EncryptedCache.open(file, new MemoryStore());
    expect(other.get('x')).toBeNull();
    other.close();

    const secrets = new MemoryStore();
    const c2 = await EncryptedCache.open(file, secrets);
    c2.set('y', { b: 2 });
    c2.close();
    const raw = new DatabaseSync(file);
    raw.exec("UPDATE kv SET ct = X'00112233'");
    raw.close();
    const c3 = await EncryptedCache.open(file, secrets);
    expect(c3.get('y')).toBeNull();
    c3.close();
  });
});
