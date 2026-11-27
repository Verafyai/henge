/**
 * The local Temporal dev server the node supervises (spin-out spec v2, 9.3): the Temporal CLI
 * binary bundled at build time (pin.ts), on 127.0.0.1 only, gRPC 7233 and Web UI 8233, with its
 * SQLite state in the app's userData folder so workflows survive the app or the worker being
 * killed. The UI news feed is off, so the server makes no outbound calls of its own.
 *
 * A server left running by a session that was killed is adopted when its pid file names a live
 * process and the port answers; otherwise a fresh one starts on the same database.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export type TemporalServerOpts = {
  /** Absolute path of the bundled `temporal` binary. */
  binary: string;
  /** Folder for the SQLite store and pid file (inside userData). */
  dataDir: string;
  namespace: string;
  port?: number;
  uiPort?: number;
  /** How long to wait for the port to answer. Engineering value. */
  readyTimeoutMs?: number;
  log?: (line: string) => void;
};

export const TEMPORAL_PORT = 7233;
export const TEMPORAL_UI_PORT = 8233;
const HOST = '127.0.0.1';

/** Where the build placed the binary: resources/temporal in a package, apps/client/resources/temporal/<platform>-<arch> unpackaged. */
export function temporalBinaryPath(o: { isPackaged: boolean; resourcesPath: string; appRoot: string; platform?: string; arch?: string }): string {
  const exe = (o.platform ?? process.platform) === 'win32' ? 'temporal.exe' : 'temporal';
  if (o.isPackaged) return path.join(o.resourcesPath, 'temporal', exe);
  return path.join(o.appRoot, 'resources', 'temporal', `${o.platform ?? process.platform}-${o.arch ?? process.arch}`, exe);
}

export function portOpen(port: number, host = HOST, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True only when `pid` is a live process running this exact binary, so a recycled pid is never touched. */
export function runsBinary(pid: number, binary: string): boolean {
  if (!alive(pid) || process.platform === 'win32') return false;
  try {
    const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2_000 }).trim();
    return cmd.startsWith(`${binary} `);
  } catch {
    return false;
  }
}

export class TemporalDevServer {
  private child: ChildProcess | null = null;
  private adoptedPid: number | null = null;
  private stopping = false;
  readonly port: number;
  readonly uiPort: number;

  constructor(private opts: TemporalServerOpts) {
    this.port = opts.port ?? TEMPORAL_PORT;
    this.uiPort = opts.uiPort ?? TEMPORAL_UI_PORT;
  }

  get address() {
    return `${HOST}:${this.port}`;
  }

  get pidFile() {
    return path.join(this.opts.dataDir, 'server.pid');
  }

  /** The pid of the server process, started or adopted. */
  get pid(): number | null {
    return this.child?.pid ?? this.adoptedPid;
  }

  async start(): Promise<void> {
    this.stopping = false;
    mkdirSync(this.opts.dataDir, { recursive: true, mode: 0o700 });
    const prev = this.readPid();
    const ours = prev !== null && runsBinary(prev, this.opts.binary);
    if (prev && ours && (await portOpen(this.port))) {
      this.adoptedPid = prev;
      this.opts.log?.(`Adopted the Temporal dev server left running (pid ${prev}).`);
      return;
    }
    if (prev && ours) {
      // Ours (our pid file, our binary) but not answering: replace it.
      try {
        process.kill(prev, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    // A server from a session that just quit may still be shutting down: give the port a moment.
    const freeBy = Date.now() + 10_000;
    while ((await portOpen(this.port)) && Date.now() < freeBy) await new Promise((r) => setTimeout(r, 200));
    if (await portOpen(this.port)) throw new Error(`Port ${this.port} is in use by another program, so the local workflow server cannot start.`);
    if (!existsSync(this.opts.binary)) throw new Error('The bundled Temporal server is missing from this build.');
    const args = [
      'server',
      'start-dev',
      '--ip',
      HOST,
      '--port',
      String(this.port),
      '--ui-ip',
      HOST,
      '--ui-port',
      String(this.uiPort),
      '--ui-disable-news-fetch',
      '--db-filename',
      path.join(this.opts.dataDir, 'temporal.sqlite'),
      '--namespace',
      this.opts.namespace,
      '--log-level',
      'error',
    ];
    // A minimal environment: the server needs nothing from the app's.
    const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: this.opts.dataDir };
    if (process.platform === 'win32') env['SystemRoot'] = process.env['SystemRoot'] ?? 'C:\\Windows';
    const child = spawn(this.opts.binary, args, { env, stdio: ['ignore', 'ignore', 'pipe'], detached: false });
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => this.opts.log?.(d.toString().slice(0, 500)));
    child.once('exit', () => {
      if (this.child === child) this.child = null;
    });
    if (child.pid) writeFileSync(this.pidFile, String(child.pid), { mode: 0o600 });
    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (!this.child) throw new Error('The local workflow server stopped while starting.');
      if (await portOpen(this.port)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    this.child?.kill('SIGKILL');
    throw new Error('The local workflow server did not start in time.');
  }

  /** Resolves when a server we started exits (not for an adopted one). */
  onExit(cb: () => void) {
    this.child?.once('exit', () => {
      if (!this.stopping) cb();
    });
  }

  /** For `will-quit`, which cannot wait: SIGTERM (the server flushes SQLite and exits) and forget it. */
  stopNow() {
    this.stopping = true;
    const pid = this.pid;
    this.child = null;
    this.adoptedPid = null;
    if (!pid) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    rmSync(this.pidFile, { force: true });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const pid = this.pid;
    const child = this.child;
    this.child = null;
    this.adoptedPid = null;
    if (!pid) return;
    const exited = child ? new Promise<void>((r) => (child.exitCode !== null ? r() : child.once('exit', () => r()))) : null;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone.
      }
    }
    await exited;
    rmSync(this.pidFile, { force: true });
  }

  private readPid(): number | null {
    try {
      const n = Number(readFileSync(this.pidFile, 'utf8').trim());
      return Number.isInteger(n) && n > 1 ? n : null;
    } catch {
      return null;
    }
  }
}
