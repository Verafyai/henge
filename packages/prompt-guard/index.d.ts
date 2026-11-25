/** Types for the vendored Prompt Guard (vendor/src, JavaScript). Only what Henge uses is typed. */
export declare const GUARD_VERSION: string;
export declare const GUARD_PROMPT_LINE: string;
export interface GuardFlag {
  rule: string;
  why: string;
  start: number;
  end: number;
  excerpt: string;
}
export interface ScanReport {
  version: string;
  flags: GuardFlag[];
  hidden: { invisible: number; bidi: number; tag: number };
  suspicious: boolean;
}
export declare function scan(text: string): ScanReport;
export interface GuardRecord {
  version: string;
  compiler: string;
  flags: Array<{ rule: string; start: number; end: number }>;
  hidden: { invisible: number; bidi: number; tag: number };
  suspicious: boolean;
  segments: Array<{ id: string; start: number; end: number; kind: 'statement' | 'directive'; rules?: string[] }>;
  sha256: string;
}
export declare function compile(text: string, extra?: { claims?: Array<{ claim: string; quote: string }>; compiler?: string }): GuardRecord;
export declare function renderGuarded(text: string, record: GuardRecord): string;
export declare function verifyGuard(text: string, record: GuardRecord): unknown;
export declare function wrap(text: string, opts?: { id?: string; label?: string; record?: GuardRecord }): string;
export declare function canonical(value: unknown): string;
export declare function sha256(value: unknown): string;
