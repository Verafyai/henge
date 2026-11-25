/**
 * Local encrypted cache (ADDENDUM A4.1, A8.2) on SQLite (`node:sqlite`, built
 * into Electron's Node). Every row is AES-256-GCM encrypted with a key held in
 * the OS keychain, and row names are HMACed, so the file reveals neither
 * contents nor which keys exist. See docs/DECISIONS.md for why this is row
 * level rather than SQLCipher page level.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import type { SecretStore } from './secrets';

type Keys = { enc: Buffer; mac: Buffer };

function deriveKeys(master: Buffer): Keys {
  const k = (info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  return { enc: k('swarm-explorer-cache-enc-v1'), mac: k('swarm-explorer-cache-mac-v1') };
}

export class EncryptedCache {
  private constructor(
    private readonly db: DatabaseSyncT,
    private readonly keys: Keys,
  ) {}

  /** Opens (or creates) the cache, creating the master key in the keychain on first run. */
  static async open(file: string, secrets: SecretStore): Promise<EncryptedCache> {
    let master = await secrets.get('cache-key');
    if (!master) {
      master = randomBytes(32).toString('base64');
      await secrets.set('cache-key', master);
    }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, iv BLOB NOT NULL, ct BLOB NOT NULL, tag BLOB NOT NULL, updated INTEGER NOT NULL);
    `);
    return new EncryptedCache(db, deriveKeys(Buffer.from(master, 'base64')));
  }

  private id(name: string): string {
    return createHmac('sha256', this.keys.mac).update(name).digest('hex');
  }

  set(name: string, value: unknown): void {
    const k = this.id(name);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys.enc, iv);
    c.setAAD(Buffer.from(k));
    const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    this.db
      .prepare('INSERT INTO kv (k, iv, ct, tag, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET iv = excluded.iv, ct = excluded.ct, tag = excluded.tag, updated = excluded.updated')
      .run(k, iv, ct, c.getAuthTag(), Date.now());
  }

  /** Returns null for missing rows and for rows that fail authentication (tampered or wrong key). */
  get<T>(name: string): T | null {
    const k = this.id(name);
    const row = this.db.prepare('SELECT iv, ct, tag FROM kv WHERE k = ?').get(k) as { iv: Uint8Array; ct: Uint8Array; tag: Uint8Array } | undefined;
    if (!row) return null;
    try {
      const d = createDecipheriv('aes-256-gcm', this.keys.enc, row.iv);
      d.setAAD(Buffer.from(k));
      d.setAuthTag(row.tag);
      return JSON.parse(Buffer.concat([d.update(row.ct), d.final()]).toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM kv WHERE k = ?').run(this.id(name));
  }

  clear(): void {
    this.db.exec('DELETE FROM kv');
  }

  close(): void {
    this.db.close();
  }
}
