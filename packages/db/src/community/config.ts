/**
 * Settings read from a Henge's `.henge` file, with the spec's labeled starting values as fallbacks.
 */
import type { HengeV1 } from '@swarm-explorer/schema';

/**
 * Spin-out spec 8.2 rate limits: "starting values to tune, not measured results". Used only when the
 * file's `community.defaults.rate_limits` leaves a key out.
 */
export const SPEC_RATE_LIMIT_FALLBACKS = {
  human_messages_per_minute: 20,
  agent_messages_per_minute: 6,
  reactions_per_minute: 30,
  new_account_messages_per_minute: 5,
} as const;
/** "new accounts limited ... for their first 24 hours" (8.2); also the link filter's "under 24 hours" (8.2). */
export const NEW_ACCOUNT_MS = 24 * 3600 * 1000;

export type RateLimits = { [K in keyof typeof SPEC_RATE_LIMIT_FALLBACKS]: number };

export function rateLimits(h: HengeV1): RateLimits {
  const file = h.community?.defaults?.rate_limits ?? {};
  const pick = (k: keyof RateLimits) => {
    const v = file[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : SPEC_RATE_LIMIT_FALLBACKS[k];
  };
  return {
    human_messages_per_minute: pick('human_messages_per_minute'),
    agent_messages_per_minute: pick('agent_messages_per_minute'),
    reactions_per_minute: pick('reactions_per_minute'),
    new_account_messages_per_minute: pick('new_account_messages_per_minute'),
  };
}

export const MODERATION_GLYPH_ID = 'verafy/moderation';
export const MODERATION_GLYPH_NAME = 'Moderation Glyph';

/**
 * Rune defaults from the built-in Moderation Glyph manifest
 * (`packages/schema/fixtures/glyphs/verafy/moderation.glyph.yaml`; a test keeps these in sync).
 */
export const MODERATION_RUNE_DEFAULTS = {
  'auto_timeout.reports': 3,
  'auto_timeout.window_minutes': 10,
  'auto_timeout.duration_minutes': 60,
  link_filter: 'new_members_only',
} as const;

export type ModerationGlyph = {
  /** Auto-timeout on report bursts; needs `moderate:timeout` granted. */
  autoTimeout: null | { reports: number; windowMinutes: number; durationMinutes: number };
  /** `off`, `new_members_only` or `all`. Needs `read:messages` granted. */
  linkFilter: 'off' | 'new_members_only' | 'all';
};

/** The Moderation Glyph as this Henge added it, or null when it is not in `glyphs[]`. */
export function moderationGlyph(h: HengeV1): ModerationGlyph | null {
  const entry = (h.glyphs ?? []).find((g) => g.use.split('@')[0] === MODERATION_GLYPH_ID);
  if (!entry) return null;
  const runes = { ...MODERATION_RUNE_DEFAULTS, ...(entry.runes ?? {}) } as Record<string, unknown>;
  const int = (k: keyof typeof MODERATION_RUNE_DEFAULTS) => {
    const v = runes[k];
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : (MODERATION_RUNE_DEFAULTS[k] as number);
  };
  const lf = runes.link_filter;
  const linkFilter = lf === 'off' || lf === false || lf === null ? 'off' : lf === 'all' ? 'all' : 'new_members_only';
  return {
    autoTimeout: entry.granted.includes('moderate:timeout')
      ? { reports: int('auto_timeout.reports'), windowMinutes: int('auto_timeout.window_minutes'), durationMinutes: int('auto_timeout.duration_minutes') }
      : null,
    linkFilter: entry.granted.includes('read:messages') ? linkFilter : 'off',
  };
}

/** Timeout presets offered by the mod tools (mockup 17 "Timeout"). Product choices, not measurements. */
export const TIMEOUT_PRESETS = { '60s': 60, '5m': 300, '10m': 600, '1h': 3600, '1d': 86_400, '1w': 604_800 } as const;
export type TimeoutPreset = keyof typeof TIMEOUT_PRESETS;

/** Ban appeal window when the mod does not choose one and the file allows appeals. */
export const DEFAULT_APPEAL_WINDOW_DAYS = 30;
/** Soft-deleted message bodies are kept this long as evidence, then purged (spec 8.2). */
export const DELETED_EVIDENCE_MS = 30 * 24 * 3600 * 1000;
/** Presence: a member without a heartbeat for this long shows offline. */
export const PRESENCE_TTL_MS = 90_000;
/** Spec 8.1 report reasons, used when the file gives none. */
export const DEFAULT_REPORT_REASONS = ['spam', 'harassment', 'off_topic', 'leaked_answer', 'other'];
export const MESSAGE_MAX_CHARS = 4000;
