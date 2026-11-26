/**
 * Types for the `.henge` file, v1 (Henge spin-out spec v2, section 6) and the Glyph manifest v1 (section 7).
 * The JSON Schemas (henge-v1.schema.json, glyph-v1.schema.json) are the strict shape checks;
 * these types describe a value that passed them.
 */
import type { Digest, ManifestIssue, ManifestSignature, ModelPolicy, VerificationMethod } from './types';

type Ext = { [extension: `x-${string}`]: unknown };
type Nullable<T> = T | null;

export interface HengeRange extends Ext {
  default?: Nullable<number>;
  min?: number;
  max?: number;
}

export interface HengeCap extends Ext {
  default: Nullable<number>;
  /** true: the client cannot finish joining until the member sets this cap (6.4). */
  required: boolean;
}

export interface HengeChannel extends Ext {
  id: string;
  name?: string;
  type: 'text' | 'announcement' | 'agent_run';
  post?: string[];
  read?: string[];
  slow_mode_s?: number;
  /** Glyph slugs (the part after `<publisher>/` in `use`) that may post here. */
  glyph_posts?: string[];
  agents?: string;
}

export interface HengeGlyphEntry extends Ext {
  /** `<publisher>/<glyph>@<range>`. */
  use: string;
  source: string;
  digest: Nullable<Digest>;
  added_by: string;
  granted: string[];
  runes?: Record<string, unknown>;
}

export interface HengeV1 extends Ext {
  henge: string;
  kind: 'swarm' | 'template';
  id: string;
  version: string;
  name: string;
  summary: string;
  description: string;
  publisher: { name: string; url: string; contact: string } & Ext;
  license?: { bundle?: string; code?: string } & Ext;
  source: { canonical_url: string; repo: string; commit: Nullable<string>; bundle_digest: Nullable<Digest> } & Ext;
  landing: {
    title: string;
    tagline: string;
    hero_image?: string;
    icon?: string;
    accent?: string;
    body: string;
    sections?: ({ title: string; body: string } & Ext)[];
    links?: ({ label: string; href: string } & Ext)[];
  } & Ext;
  admission: {
    mode: 'open' | 'request' | 'invite' | 'allowlist';
    identity: ('github' | 'email' | 'key')[];
    requirements: { min_client_version: string; qualification?: { tasks: number; pass: number } & Ext; attest?: string[] } & Ext;
    review?: { by?: string[]; sla_hours?: Nullable<number> } & Ext;
    capacity?: { max_members?: Nullable<number> } & Ext;
    leave?: { allowed?: boolean; data_on_leave?: 'keep_contributions' | 'delete_my_contributions' } & Ext;
  } & Ext;
  governance: {
    roles: Record<'owner' | 'maintainer' | 'mod' | 'member' | 'agent' | 'observer', { can: string[] }> & Record<string, { can: string[] }>;
    holders: { owner: string[] } & Record<string, string[]>;
    voting: { glyph: string } & Ext;
    rule_updates: {
      file_updates_by: string[];
      vote_required_for: string[];
      no_vote_needed_for?: string[];
      changelog?: string;
      signed_releases?: boolean;
      member_reconsent_on: string[];
    } & Ext;
    constitution: { immutable: string[] } & Ext;
    forks?: { allowed?: boolean; must_change_id?: boolean } & Ext;
  } & Ext;
  participation: {
    roles_offered: ({ id: string; description?: string } & Ext)[];
    compute: { cpu_cores: HengeRange; ram_gb: HengeRange; gpu: { allowed: boolean } & Ext; scratch_disk_gb: HengeRange } & Ext;
    models: {
      policy: ModelPolicy;
      class?: string;
      allowed_classes?: string[];
      byo_api_key: boolean;
      local_models: boolean;
      allowed_providers?: string[];
      diversity?: { min_families: number; min_accounts: number } & Ext;
    } & Ext;
    budget: { currency: string; daily_cap: HengeCap; monthly_cap?: HengeCap; hard_stop: boolean } & Ext;
    schedule: { default: 'always' | 'idle_only' | 'windows'; windows?: string[]; windows_example?: string[]; pause_on_battery?: boolean } & Ext;
  } & Ext;
  task: {
    type: string;
    description: string;
    input_schema: string;
    output_schema: string;
    timeout_s: number;
    max_parallel_per_node: number;
    permissions: { network: string[]; tools?: string[] } & Ext;
    verification: VerificationMethod[];
    verification_config: {
      known_answer_rate?: Nullable<number>;
      redundancy_count?: Nullable<number>;
      jury_panel_size?: Nullable<number>;
      pending_window_s: number;
    } & Ext;
  } & Ext;
  benchmarks: ({
    id: string;
    name?: string;
    dataset: {
      uri: string;
      digest: Nullable<Digest>;
      frozen_at: Nullable<string>;
      splits: { dev: string; test: string; heldout: string } & Ext;
    } & Ext;
    contamination: { exclude_domains?: string[]; cutoff_rule?: string; log_blocked_hits?: boolean } & Ext;
    scorer: { path: string; digest: Nullable<Digest> } & Ext;
    metrics: ({ id: string; direction: 'lower_is_better' | 'higher_is_better'; description?: string } & Ext)[];
    conditions?: ({ id: string; description?: string } & Ext)[];
    baselines?: ({ id: string; description?: string } & Ext)[];
    runs_per_condition?: number;
    leaderboard?: string;
    results?: Record<string, unknown>[];
  } & Ext)[];
  strategies?: ({
    id: string;
    path: string;
    applies_to?: string[];
    status: 'draft' | 'active' | 'retired';
    introduced_in?: string;
    evidence?: string[];
  } & Ext)[];
  learnings?: {
    path: string;
    format: 'jsonl';
    append_only: true;
    entry_schema?: string;
    required_fields?: string[];
    kinds?: string[];
    promotion?: { requires_heldout_gain?: boolean; min_runs?: number; reviewed_by?: string[] } & Ext;
    forbidden?: string[];
    max_context_tokens?: number;
  } & Ext;
  glyphs?: HengeGlyphEntry[];
  community?: {
    enabled?: boolean;
    categories?: ({ id: string; name?: string; channels: HengeChannel[] } & Ext)[];
    defaults?: {
      new_member_role?: string;
      agents_role?: string;
      agent_messages_labeled?: boolean;
      mentions_everyone?: string[];
      rate_limits?: Record<string, number>;
    } & Ext;
    moderation?: { report_reasons?: string[]; audit_log?: 'append_only'; ban_appeals?: boolean } & Ext;
  } & Ext;
  runtime: {
    engine: 'temporal';
    mode: 'local_single_node' | 'coordinated';
    temporal: {
      address?: string;
      ui?: string;
      namespace: string;
      task_queue: string;
      workflow: string;
      continue_as_new_after_events?: number;
      activity?: {
        start_to_close_s?: number;
        heartbeat_s?: number;
        retry?: { initial_interval_s?: number; backoff?: number; max_attempts?: number } & Ext;
      } & Ext;
    } & Ext;
    harness: { name: string; version: string; runtime: 'wasm' | 'container'; image?: string; hash?: Digest } & Ext;
    coordinator: { mode: 'hosted' | 'self_hosted'; url: Nullable<string>; public_key: Nullable<string> } & Ext;
  } & Ext;
  data_policy: { public_inputs: boolean; retention_days: number; sensitive_data_prohibited: boolean } & Ext;
  signatures?: ManifestSignature[];
}

export type HengeResult = { ok: true; henge: HengeV1; unchecked: string[] } | { ok: false; issues: ManifestIssue[] };

/* ----------------------------------------------------------------------------------------------- */
/* Glyph manifest v1 (section 7.2)                                                                  */
/* ----------------------------------------------------------------------------------------------- */

export const GLYPH_KINDS = ['governance', 'treasury', 'benchmark', 'strategy', 'learnings', 'moderation', 'community', 'custom'] as const;
export const RUNE_TYPES = ['boolean', 'number', 'integer', 'percent', 'duration', 'enum', 'string', 'list', 'roles', 'channel'] as const;

export type GlyphKind = (typeof GLYPH_KINDS)[number];
export type RuneType = (typeof RUNE_TYPES)[number];

export interface RuneV1 {
  id: string;
  name: string;
  description?: string;
  type: RuneType;
  default?: unknown;
  min?: number;
  max?: number;
  options?: unknown[];
  unit?: string;
  /** Who must approve a change. The schema default is `vote`. */
  change_requires?: 'vote' | 'maintainer' | 'owner';
  cosmetic?: boolean;
}

export interface GlyphManifestV1 extends Ext {
  glyph: '1.0';
  id: string;
  name: string;
  version: string;
  kind: GlyphKind;
  summary: string;
  description?: string;
  icon?: string;
  publisher: { name: string; url: string; contact?: string };
  source?: { repo?: string; commit?: Nullable<string>; bundle_digest?: Nullable<string> };
  runtime: {
    type: 'declarative' | 'wasm' | 'container';
    entry?: string;
    digest?: Nullable<string>;
    runs_on?: 'coordinator' | 'local_node' | 'both';
    temporal?: { workflows?: string[]; task_queue_suffix?: string };
  };
  permissions: { requests: string[]; never?: string[] };
  runes?: RuneV1[];
  channels?: { id: string; type: 'text' | 'announcement' | 'agent_run'; category?: string }[];
  commands?: { name: string; description: string; roles?: string[] }[];
  events?: string[];
  compat: { henge: string; min_client_version?: string };
  signatures?: ManifestSignature[];
}

export type GlyphResult = { ok: true; glyph: GlyphManifestV1 } | { ok: false; issues: ManifestIssue[] };
