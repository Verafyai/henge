import type { CATEGORIES, MODEL_POLICIES, VERIFICATION_METHODS } from './json-schema';

export type Category = (typeof CATEGORIES)[number];
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];
export type ModelPolicy = (typeof MODEL_POLICIES)[number];
/** `sha256-<hex>`, the only digest encoding a manifest accepts (SPEC 6.5). */
export type Digest = `sha256-${string}`;

export interface ManifestSignature {
  key_id: string;
  algorithm: 'ed25519';
  signature: string;
}

/** A manifest that passed `manifestV1Schema`. Shape follows SPEC 6.4 exactly. */
export interface ManifestV1 {
  manifest_version: 1;
  id: string;
  name: string;
  publisher: string;
  category: Category;
  summary: string;
  harness: { name: string; version: string; hash: Digest; runtime: 'wasm' | 'container' };
  models: {
    policy: ModelPolicy;
    class?: string;
    allowed_classes?: string[];
    api_allowed: boolean;
    diversity?: { min_families: number; min_accounts: number };
  };
  verification: VerificationMethod[];
  verification_config: {
    known_answer_rate?: number | null;
    redundancy_count?: number | null;
    jury_panel_size?: number | null;
    pending_window_s: number;
  };
  permissions: { network: string[]; scratch_disk_gb: number; gpu_compute: boolean; api_spend_daily_usd: number | null };
  credits: { funded: boolean; per_accepted_task: number | null; pool_id: string | null };
  impact: { category_weight: number };
  task: { timeout_s: number; max_parallel_per_node: number; urgent_allowed: boolean; input_schema: string; output_schema: string };
  qualification: { tasks: number; pass: number };
  results_url: string;
  coordinator: { mode: 'hosted' | 'self_hosted'; url: string | null; public_key: string | null };
  data_policy: { public_inputs: boolean; retention_days: number; sensitive_data_prohibited: boolean };
  min_client_version: string;
  signatures?: ManifestSignature[];
  [extension: `x-${string}`]: unknown;
}

/** One problem with a manifest. `path` is a JSON Pointer into the manifest. */
export interface ManifestIssue {
  code: string;
  path: string;
  message: string;
}

export type ManifestResult = { ok: true; manifest: ManifestV1 } | { ok: false; issues: ManifestIssue[] };
