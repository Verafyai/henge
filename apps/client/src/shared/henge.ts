/**
 * Henges on this computer (spin-out spec v2, 6.5 and 9.2): the `.henge` files you joined or created,
 * your participation choices and the pin the client resolved. Types only cross the bridge; the
 * main process owns the files and re-checks every write.
 */
import type { GlyphManifestV1, HengePin, HengeV1, RuneChangePlan } from '@swarm-explorer/schema';
import { z } from 'zod';

export type HengeStatus =
  /** You created it on this computer. You are the owner. */
  | 'owner'
  /** Joined; admission.mode is open. */
  | 'joined'
  /** Joined with request, invite or allowlist admission: nothing runs until a maintainer admits you. */
  | 'awaiting_admission';

export const participationSchema = z
  .object({
    role: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    /** Content hash of an installed local model, or null when none is chosen yet. */
    model: z.string().regex(/^sha256-[a-f0-9]{64}$/).nullable(),
    /** Whole US cents, or null when the Henge does not require a cap and none was set. */
    dailyCapCents: z.number().int().min(1).max(100_000_000).nullable(),
    cpuCores: z.number().int().min(1).max(512),
    schedule: z.enum(['always', 'idle_only', 'windows']),
    reconsent: z.boolean(),
  })
  .strict();
export type Participation = z.infer<typeof participationSchema>;

export type LocalHenge = {
  /** Stable local key: the Henge id with `/` replaced by `--`. */
  key: string;
  henge: HengeV1;
  status: HengeStatus;
  /** The URL it was joined from; null for a Henge created here. */
  sourceUrl: string | null;
  pin: HengePin | null;
  participation: Participation | null;
  /** Where the `.henge` file is stored on this computer. */
  file: string;
  addedAt: number;
};

/** What a pasted link resolved to, before anything is joined. */
export type HengeResolveView =
  | {
      ok: true;
      url: string;
      henge: HengeV1;
      pin: HengePin;
      /** Glyph entries with no manifest the client knows, so their Runes and grants were not checked. */
      unchecked: string[];
      /** Already on this computer under this key. */
      existingKey: string | null;
    }
  | { ok: false; code: string; message: string; issues: Array<{ code: string; path: string; message: string }> };

export const joinInputSchema = z
  .object({
    url: z.string().min(1).max(2048),
    /** The digest the invite card showed; main refuses if the resolved file changed since. */
    bundleDigest: z.string().regex(/^sha256-[a-f0-9]{64}$/),
    participation: participationSchema,
    /** The attest statements the member ticked, in file order. */
    attested: z.array(z.string().max(500)).max(50),
  })
  .strict();
export type JoinInput = z.infer<typeof joinInputSchema>;

export const createInputSchema = z
  .object({
    template: z.enum(['forecasting']),
    name: z.string().trim().min(1).max(60),
    /** One or two characters shown on the rail. */
    icon: z.string().trim().min(1).max(2),
    tagline: z.string().trim().max(140),
    channels: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).min(1).max(20),
    glyphs: z.array(z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/)).max(20),
    storage: z.enum(['local']),
    ownerHandle: z.string().regex(/^[a-z0-9._-]{1,39}$/),
  })
  .strict();
export type CreateInput = z.infer<typeof createInputSchema>;

export const glyphAddInputSchema = z
  .object({
    key: z.string().max(200),
    glyphId: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/),
    granted: z.array(z.string().max(200)).max(50),
  })
  .strict();
export type GlyphAddInput = z.infer<typeof glyphAddInputSchema>;

export type IssueView = { code: string; path: string; message: string };

/** How Add a Glyph would go for this Henge and actor (7.5 step 4), or why it cannot. */
export type GlyphAddPlan = {
  /** add: the actor may add it directly. propose: it opens a Governance Glyph proposal. none: the actor cannot do either. */
  mode: 'add' | 'propose' | 'none';
  reason: string;
  issues: IssueView[];
};

export type GlyphAddResult = { ok: true; mode: 'added' | 'proposed'; henge: LocalHenge } | { ok: false; issues: IssueView[] };

export const runeInputSchema = z
  .object({
    key: z.string().max(200),
    glyphId: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/),
    changes: z.record(z.string().max(100), z.unknown()),
  })
  .strict();
export type RuneInput = z.infer<typeof runeInputSchema>;

export type RunePlanView = RuneChangePlan;
export type RuneApplyResult = { ok: true; henge: LocalHenge; applied: string[]; proposal: Record<string, unknown> } | { ok: false; issues: IssueView[] };

export type GlyphCatalogItem = GlyphManifestV1;
