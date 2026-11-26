/**
 * Coordinator-side Lean check for Challenge Vaults (decision 2026-11-25): nodes only return candidate
 * proofs as text, and this machine-check verifier decides. It runs in the verifier worker, never in a
 * web function.
 *
 * The candidate is untrusted code: Lean can run programs while elaborating (`#eval`, `run_cmd`,
 * macros). So, before Lean ever sees it:
 * - the theorem statement is the pinned one from the task, never the candidate's; a candidate that
 *   restates the theorem must restate it exactly;
 * - `sorry`, `admit`, `axiom`, commands (`#eval`, `#exit`, ...), new declarations, attributes,
 *   options, macros, syntax and imports are refused outright, even inside comments;
 * and when it runs:
 * - Lean runs in a fresh temp folder with a minimal environment, a wall-clock limit (the whole
 *   process group is killed) and no network (sandbox-exec on macOS, a network namespace on Linux;
 *   with neither available the check refuses to run);
 * - `#print axioms` is appended after the candidate, and only Lean's three standard axioms are
 *   allowed, so `sorryAx` or any other axiom rejects the proof.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digest, type Verdict, type Verifier } from '../records';

export const LEAN_CHECK_VERSION = 'lean-check-v1';
export const ALLOWED_AXIOMS = new Set(['propext', 'Classical.choice', 'Quot.sound']);

export type Isolation = 'sandbox-exec' | 'unshare' | 'none';

export type LeanConfig = {
  /** `lean`, or `lake` with args `['env', 'lean']` inside a project. */
  command: string;
  args?: string[];
  /** Project folder for `lake env lean`; the checked file is still written to a temp folder. */
  cwd?: string;
  /** Engineering wall-clock limit for one check. */
  timeoutMs: number;
  isolation: Isolation;
};

/** The no-network wrapper this machine supports, or 'none'. */
export function detectIsolation(platform = process.platform): Isolation {
  if (platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) return 'sandbox-exec';
  if (platform === 'linux' && (existsSync('/usr/bin/unshare') || existsSync('/bin/unshare'))) return 'unshare';
  return 'none';
}

const NO_NETWORK_PROFILE = '(version 1)(allow default)(deny network*)';

const FORBIDDEN: Array<[string, RegExp]> = [
  ['sorry', /\bsorry\b/],
  ['admit', /\badmit\b/],
  ['axiom', /\baxioms?\b/],
  ['command', /#[A-Za-z_]/],
  ['declaration', /\b(theorem|lemma|def|abbrev|instance|example|structure|inductive|class|opaque|axiom|constant)\b/],
  ['unsafe', /\b(unsafe|partial|implemented_by|extern|noncomputable|native_decide)\b/],
  ['attribute', /@\[|\battribute\b/],
  ['option', /\bset_option\b/],
  ['metaprogram', /\b(macro|macro_rules|syntax|elab|elab_rules|notation|infix|infixl|infixr|prefix|postfix|run_cmd|run_tac|run_elab|meta)\b/],
  ['scope', /\b(import|namespace|section|end|variable|universe|mutual)\b/],
];

/** The theorem name of a pinned statement, for example `theorem foo (n : Nat) : n + 0 = n`. */
export function theoremName(statement: string): string | null {
  return /^\s*(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_.']*)/.exec(statement)?.[1] ?? null;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Builds the proof body to place after the pinned statement, or refuses. A candidate may be a full
 * restatement (`theorem ... := proof`, which must restate the pinned statement exactly), `:= term`,
 * `by tactics`, a term starting with `fun`, `⟨`, `(` or `@`, or a bare tactic script.
 */
export function proofBody(statement: string, candidate: string): { ok: true; body: string } | { ok: false; code: string } {
  let c = candidate.replace(/\r\n?/g, '\n').trim();
  if (!c) return { ok: false, code: 'empty_proof' };
  if (c.length > 200_000) return { ok: false, code: 'proof_too_large' };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(c)) return { ok: false, code: 'control_characters' };
  if (/^(theorem|lemma)\b/.test(c)) {
    const i = c.indexOf(':=');
    if (i < 0 || norm(c.slice(0, i)) !== norm(statement)) return { ok: false, code: 'statement_changed' };
    c = c.slice(i + 2).trim();
  } else if (c.startsWith(':=')) c = c.slice(2).trim();
  if (!c) return { ok: false, code: 'empty_proof' };
  for (const [code, re] of FORBIDDEN) if (re.test(c)) return { ok: false, code: `forbidden_${code}` };
  if (/^by\b/.test(c) || /^(fun\b|λ|⟨|\(|@)/.test(c)) return { ok: true, body: c };
  return { ok: true, body: `by\n${c.split('\n').map((l) => `  ${l}`).join('\n')}` };
}

type Run = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function run(cfg: LeanConfig, file: string, dir: string): Promise<Run> {
  const base = [...(cfg.args ?? []), file];
  let cmd = cfg.command;
  let args = base;
  if (cfg.isolation === 'sandbox-exec') {
    cmd = '/usr/bin/sandbox-exec';
    args = ['-p', NO_NETWORK_PROFILE, cfg.command, ...base];
  } else if (cfg.isolation === 'unshare') {
    cmd = 'unshare';
    args = ['--net', '--map-root-user', cfg.command, ...base];
  }
  // A minimal environment: enough for elan's toolchain shims, nothing else from this process.
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? dir, TMPDIR: dir, LANG: 'C.UTF-8' };
  for (const k of ['ELAN_HOME', 'LEAN_PATH', 'LEAN_SYSROOT']) if (process.env[k]) env[k] = process.env[k]!;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: cfg.cwd ?? dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s: string, b: Buffer) => (s.length > 1_000_000 ? s : s + b.toString('utf8'));
    child.stdout.on('data', (b: Buffer) => (stdout = cap(stdout, b)));
    child.stderr.on('data', (b: Buffer) => (stderr = cap(stderr, b)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, cfg.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${String(e)}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Axioms reported by `#print axioms`; null when Lean printed no axiom line for the theorem. */
export function reportedAxioms(output: string, name: string): string[] | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`'${esc}' does not depend on any axioms`).test(output)) return [];
  const m = new RegExp(`'${esc}' depends on axioms: \\[([^\\]]*)\\]`).exec(output);
  return m ? m[1]!.split(',').map((s) => s.trim()).filter(Boolean) : null;
}

export type LeanInput = { statement: string; header?: string | null; candidate: { status: string; proof: string | null } };

const reject = (rationaleCode: string, evidenceHashes: string[] = []): Verdict => ({ outcome: 'rejected', rationaleCode, evidenceHashes, verifierVersion: LEAN_CHECK_VERSION });

/** The Lean machine-check verifier. `cfg.isolation: 'none'` refuses every check. */
export function leanVerifier(cfg: LeanConfig): Verifier<LeanInput> {
  return {
    method: 'machine-check',
    version: LEAN_CHECK_VERSION,
    async verify(i) {
      if (i.candidate.status !== 'proved' || !i.candidate.proof) return reject('no_candidate');
      const name = theoremName(i.statement);
      if (!name) return reject('unpinned_statement');
      const body = proofBody(i.statement, i.candidate.proof);
      if (!body.ok) return reject(body.code);
      if (cfg.isolation === 'none') return null; // Cannot run without network isolation: wait for a capable worker.
      const header = i.header ? `${i.header.trim()}\n\n` : '';
      if (/\b(sorry|admit|axiom)\b|#(?!print axioms)/.test(header)) return reject('forbidden_header');
      const source = `${header}${i.statement.trim()} :=\n${body.body}\n\n#print axioms ${name}\n`;
      const dir = mkdtempSync(path.join(tmpdir(), 'lean-check-'));
      try {
        const file = path.join(dir, 'Check.lean');
        writeFileSync(file, source, { mode: 0o600 });
        const r = await run(cfg, file, dir);
        const out = `${r.stdout}\n${r.stderr}`;
        const evidence = [digest(source), digest(out)];
        if (r.timedOut) return reject('check_timeout', evidence);
        if (r.code !== 0) return reject('lean_rejected', evidence);
        const axioms = reportedAxioms(out, name);
        if (axioms === null) return reject('axioms_unreported', evidence);
        const bad = axioms.filter((a) => !ALLOWED_AXIOMS.has(a));
        if (bad.length) return reject(bad.includes('sorryAx') ? 'uses_sorry' : 'disallowed_axiom', evidence);
        return { outcome: 'accepted', rationaleCode: 'lean_proof_checked', evidenceHashes: evidence, verifierVersion: LEAN_CHECK_VERSION };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
