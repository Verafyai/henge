import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { proxySocketDir, proxySocketPath } from './socket-path';

describe('model proxy socket path (SPEC 11.2)', () => {
  it('uses the profile when short enough, else a per-profile temp folder; a named pipe on Windows', () => {
    expect(proxySocketDir('/Users/a/Library/Application Support/Swarm Explorer')).toBe('/Users/a/Library/Application Support/Swarm Explorer/run');
    const long = `/private/var/folders/${'x'.repeat(60)}/T/profile`;
    const dir = proxySocketDir(long);
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    expect(proxySocketDir(long)).toBe(dir);
    expect(proxySocketDir(`${long}2`)).not.toBe(dir);
    expect(proxySocketPath(long, 'abcd1234').length).toBeLessThanOrEqual(100);
    expect(proxySocketPath('/x', 'abcd1234', 'win32')).toBe('\\\\.\\pipe\\swarm-explorer-proxy-abcd1234');
  });
});
