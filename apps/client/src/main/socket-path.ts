/**
 * Where the model proxy listens (SPEC 11.2): a 0700 folder under the profile, or a named pipe on
 * Windows. Never a TCP port. Unix socket paths are limited to about 104 bytes, so long profile
 * paths fall back to a per-profile folder in the temp directory.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const MAX_UNIX_SOCKET_PATH = 100;

export function proxySocketDir(userDataDir: string): string {
  const preferred = path.join(userDataDir, 'run');
  if (preferred.length + 'proxy-00000000.sock'.length + 1 <= MAX_UNIX_SOCKET_PATH) return preferred;
  return path.join(os.tmpdir(), `se-run-${createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)}`);
}

export function proxySocketPath(userDataDir: string, tag: string, platform = process.platform): string {
  if (platform === 'win32') return `\\\\.\\pipe\\swarm-explorer-proxy-${tag}`;
  return path.join(proxySocketDir(userDataDir), `proxy-${tag}.sock`);
}
