/**
 * Scratch disk (SPEC 11.3, 11.4): a private, size-capped folder per swarm, deleted when the swarm
 * is removed. Names are flat (no folders), so a harness cannot traverse, follow links, or name
 * anything outside its own folder.
 */
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SCRATCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class ScratchError extends Error {
  constructor(readonly code: 'bad_name' | 'quota_exceeded' | 'not_found' | 'disabled') {
    super(code);
  }
}

export class Scratch {
  private constructor(
    readonly dir: string,
    readonly quotaBytes: number,
  ) {}

  /** `root` is the app's scratch root; `swarm` is a validated slug. */
  static async open(root: string, swarm: string, quotaBytes: number): Promise<Scratch> {
    if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(swarm) || swarm.includes('..')) throw new ScratchError('bad_name');
    const dir = path.join(root, swarm);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return new Scratch(dir, quotaBytes);
  }

  private file(name: string): string {
    if (!SCRATCH_NAME.test(name) || name === '.' || name === '..') throw new ScratchError('bad_name');
    return path.join(this.dir, name);
  }

  async usedBytes(): Promise<number> {
    let n = 0;
    for (const f of await readdir(this.dir)) {
      const s = await lstat(path.join(this.dir, f));
      n += s.size;
    }
    return n;
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    if (this.quotaBytes <= 0) throw new ScratchError('disabled');
    const p = this.file(name);
    let existing = 0;
    try {
      const s = await lstat(p);
      if (!s.isFile()) throw new ScratchError('bad_name');
      existing = s.size;
    } catch (e) {
      if (e instanceof ScratchError) throw e;
    }
    if ((await this.usedBytes()) - existing + data.byteLength > this.quotaBytes) throw new ScratchError('quota_exceeded');
    await writeFile(p, data, { mode: 0o600, flag: 'w' });
  }

  async read(name: string): Promise<Buffer> {
    if (this.quotaBytes <= 0) throw new ScratchError('disabled');
    const p = this.file(name);
    const s = await lstat(p).catch(() => null);
    if (!s || !s.isFile()) throw new ScratchError('not_found');
    return readFile(p);
  }

  /** Called when the swarm is removed. */
  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
