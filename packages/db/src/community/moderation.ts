/**
 * Moderation (spin-out spec 8.1 "Moderation", "Reports"; 8.2 "Abuse and report flow"; mockup 17) and
 * the Moderation Glyph (7.1). Every action writes the append-only audit log, Glyph actions included.
 */
import type { HengeV1 } from '@swarm-explorer/schema';
import { and, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from '../client';
import { communityAuditLog, communityBans, communityMembers, communityMessages, communityReports, communityTimeouts, type CommunityMember } from '../community-schema';
import {
  activeBan,
  activeTimeout,
  actorCards,
  audit,
  can,
  channelAccess,
  CommunityError,
  deletedCard,
  emit,
  forbidden,
  GLYPH_ACTOR,
  isUuid,
  loadHenge,
  notFound,
  requireCap,
  type Access,
  type Actor,
  type ActorRef,
  type Exec,
} from './context';
import { DEFAULT_APPEAL_WINDOW_DAYS, DEFAULT_REPORT_REASONS, moderationGlyph, TIMEOUT_PRESETS, type TimeoutPreset } from './config';
import { memberRow, removeMember } from './henges';
import { messageDtos, softDelete } from './messages';
import { GLYPH_RANK, rank } from './perms';
import { ULID_RE } from './ulid';

const invalid = (code: string, message: string, details?: Record<string, unknown>) => new CommunityError(400, code, message, details);
const by = (acc: Access): ActorRef => ({ type: acc.actor.type, id: acc.actor.id });

function cleanReason(r: unknown, required = true): string | null {
  const s = typeof r === 'string' ? r.trim().slice(0, 512) : '';
  if (!s && required) throw invalid('reason_required', 'Give a reason. It is kept in the audit log.');
  return s || null;
}

async function target(acc: Access, actorId: string): Promise<CommunityMember> {
  const db = await getDb();
  const m = await memberRow(db, acc.henge.id, actorId);
  if (m.actorId === acc.actor.id) throw forbidden('cannot_target_self', 'You cannot do that to yourself.');
  if (rank(m.roles) >= rank(acc.roles)) throw forbidden('outranked', 'You cannot moderate someone at or above your rank.');
  return m;
}

/** "1 hour", "10 minutes": the audit log reads like a sentence (mockup 17). */
export function humanDuration(seconds: number): string {
  const units: [number, string][] = [[604_800, 'week'], [86_400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
  for (const [n, name] of units) if (seconds % n === 0 && seconds >= n) return `${seconds / n} ${name}${seconds / n === 1 ? '' : 's'}`;
  return `${seconds} seconds`;
}

/* ---------------------------------------------------------------------------------------------- */
/* Timeouts, kicks, bans, bulk delete                                                              */
/* ---------------------------------------------------------------------------------------------- */

export async function timeoutMember(acc: Access, actorId: string, input: { preset: string; reason: unknown }, now = new Date()) {
  requireCap(acc, 'timeout', 'Your role cannot time members out.');
  const seconds = TIMEOUT_PRESETS[input.preset as TimeoutPreset];
  if (!seconds) throw invalid('timeout_preset_invalid', `Timeouts are one of ${Object.keys(TIMEOUT_PRESETS).join(', ')}.`);
  const reason = cleanReason(input.reason)!;
  const m = await target(acc, actorId);
  return applyTimeout(await getDb(), acc.henge.id, m, seconds, reason, by(acc), now);
}

async function applyTimeout(db: Exec, hengeId: string, m: CommunityMember, seconds: number, reason: string, actor: ActorRef, now: Date, auditReason?: string) {
  const until = new Date(now.getTime() + seconds * 1000);
  await db.insert(communityTimeouts).values({ hengeId, actorId: m.actorId, actorType: m.actorType, until, reason, byType: actor.type, byId: actor.id, createdAt: now });
  await audit(db, { hengeId, actor, action: 'member.timed_out', targetType: m.actorType, targetId: m.actorId, reason: auditReason ?? reason, payload: { duration_s: seconds, until: until.toISOString() } }, now);
  await emit(db, { hengeId, kind: 'member.timed_out', payload: { actor_id: m.actorId, until: until.toISOString() } }, now);
  return { actor_id: m.actorId, until: until.toISOString() };
}

export async function clearTimeout(acc: Access, actorId: string, now = new Date()) {
  requireCap(acc, 'timeout', 'Your role cannot clear timeouts.');
  const db = await getDb();
  const m = await memberRow(db, acc.henge.id, actorId);
  const cleared = await db
    .update(communityTimeouts)
    .set({ clearedAt: now })
    .where(and(eq(communityTimeouts.hengeId, acc.henge.id), eq(communityTimeouts.actorId, m.actorId), gt(communityTimeouts.until, now), isNull(communityTimeouts.clearedAt)))
    .returning();
  if (cleared.length) {
    await audit(db, { hengeId: acc.henge.id, actor: by(acc), action: 'member.timeout_cleared', targetType: m.actorType, targetId: m.actorId }, now);
    await emit(db, { hengeId: acc.henge.id, kind: 'member.timed_out', payload: { actor_id: m.actorId, until: null } }, now);
  }
  return { cleared: cleared.length > 0 };
}

/** Kicking a person also removes their agents from this Henge. They may join again. */
export async function kickMember(acc: Access, actorId: string, input: { reason: unknown }, now = new Date()) {
  requireCap(acc, 'kick', 'Your role cannot remove members.');
  const reason = cleanReason(input.reason)!;
  const m = await target(acc, actorId);
  const db = await getDb();
  const removed = await removeMember(acc.henge.id, m.ownerAccountId, m.actorType === 'agent' ? m.actorId : null, now);
  await audit(db, { hengeId: acc.henge.id, actor: by(acc), action: 'member.kicked', targetType: m.actorType, targetId: m.actorId, reason, payload: { removed: removed.map((r) => r.actorId) } }, now);
  return { removed: removed.map((r) => r.actorId) };
}

/**
 * Bans block an account and all its agents in this Henge (spec 8.2). With `ban_appeals` (default on),
 * the banned member can appeal until `appeal_until`.
 */
export async function banMember(acc: Access, actorId: string, input: { reason: unknown; appeal_window_days?: number }, now = new Date()) {
  requireCap(acc, 'ban', 'Your role cannot ban members.');
  const reason = cleanReason(input.reason)!;
  const m = await target(acc, actorId);
  const appeals = acc.file.community?.moderation?.ban_appeals !== false;
  const days = input.appeal_window_days ?? DEFAULT_APPEAL_WINDOW_DAYS;
  if (!Number.isInteger(days) || days < 0 || days > 365) throw invalid('appeal_window_invalid', 'The appeal window is 0 to 365 days.');
  const appealUntil = appeals && days > 0 ? new Date(now.getTime() + days * 86_400_000) : null;
  const db = await getDb();
  const ins = await db
    .insert(communityBans)
    .values({ hengeId: acc.henge.id, actorId: m.actorId, actorType: m.actorType, reason, bannedByType: acc.actor.type, bannedById: acc.actor.id, appealUntil, createdAt: now })
    .onConflictDoNothing()
    .returning();
  if (!ins.length) throw new CommunityError(409, 'already_banned', 'That member is already banned.');
  const removed = await removeMember(acc.henge.id, m.ownerAccountId, m.actorType === 'agent' ? m.actorId : null, now);
  await audit(db, { hengeId: acc.henge.id, actor: by(acc), action: 'member.banned', targetType: m.actorType, targetId: m.actorId, reason, payload: { appeal_until: appealUntil?.toISOString() ?? null, removed: removed.map((r) => r.actorId) } }, now);
  await emit(db, { hengeId: acc.henge.id, kind: 'member.banned', payload: { actor_id: m.actorId, removed: removed.map((r) => r.actorId) } }, now);
  return { actor_id: m.actorId, appeal_until: appealUntil?.toISOString() ?? null };
}

export async function unban(acc: Access, actorId: string, input: { reason?: unknown }, now = new Date()) {
  requireCap(acc, 'ban', 'Your role cannot lift bans.');
  if (!isUuid(actorId)) throw notFound('ban');
  const db = await getDb();
  const lifted = await db
    .update(communityBans)
    .set({ liftedAt: now, liftedById: acc.actor.id })
    .where(and(eq(communityBans.hengeId, acc.henge.id), eq(communityBans.actorId, actorId), isNull(communityBans.liftedAt)))
    .returning();
  if (!lifted.length) throw notFound('ban');
  await audit(db, { hengeId: acc.henge.id, actor: by(acc), action: 'member.unbanned', targetType: lifted[0]!.actorType, targetId: actorId, reason: cleanReason(input.reason, false) }, now);
  return { lifted: true };
}

export async function listBans(acc: Access) {
  requireCap(acc, 'ban', 'Your role cannot see bans.');
  const db = await getDb();
  const rows = await db.select().from(communityBans).where(and(eq(communityBans.hengeId, acc.henge.id), isNull(communityBans.liftedAt))).orderBy(desc(communityBans.createdAt));
  const cards = await actorCards(db, rows.flatMap((r) => [{ type: r.actorType, id: r.actorId }, { type: r.bannedByType, id: r.bannedById }]));
  return {
    items: rows.map((r) => ({
      actor: cards.get(r.actorId) ?? deletedCard(r.actorId),
      reason: r.reason,
      banned_by: cards.get(r.bannedById) ?? deletedCard(r.bannedById),
      appeal_until: r.appealUntil?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
    })),
  };
}

/** Longest window for "delete recent messages". */
export const BULK_DELETE_MAX_MINUTES = 24 * 60;

export async function bulkDelete(acc: Access, actorId: string, input: { minutes: number; reason: unknown }, now = new Date()) {
  requireCap(acc, 'bulk_delete', 'Your role cannot bulk delete messages.');
  const minutes = input.minutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > BULK_DELETE_MAX_MINUTES) throw invalid('minutes_invalid', `Choose 1 to ${BULK_DELETE_MAX_MINUTES} minutes.`);
  const reason = cleanReason(input.reason)!;
  const db = await getDb();
  if (!isUuid(actorId)) throw notFound('member');
  const [m] = await db.select().from(communityMembers).where(and(eq(communityMembers.hengeId, acc.henge.id), eq(communityMembers.actorId, actorId))).limit(1);
  if (m && rank(m.roles) >= rank(acc.roles)) throw forbidden('outranked', 'You cannot moderate someone at or above your rank.');
  const rows = await db
    .select()
    .from(communityMessages)
    .where(and(eq(communityMessages.hengeId, acc.henge.id), eq(communityMessages.authorId, actorId), isNull(communityMessages.deletedAt), gte(communityMessages.createdAt, new Date(now.getTime() - minutes * 60_000))));
  for (const r of rows) await softDelete(db, r, by(acc), reason, now);
  await audit(db, { hengeId: acc.henge.id, actor: by(acc), action: 'messages.bulk_deleted', targetType: m?.actorType ?? 'actor', targetId: actorId, reason, payload: { count: rows.length, minutes, kept_days: 30 } }, now);
  return { deleted: rows.length };
}

/* ---------------------------------------------------------------------------------------------- */
/* Reports and the Moderation Glyph                                                                */
/* ---------------------------------------------------------------------------------------------- */

export function reportReasons(f: HengeV1): string[] {
  return f.community?.moderation?.report_reasons ?? DEFAULT_REPORT_REASONS;
}

export async function reportMessage(acc: Access, input: { message_id: string; reason: string; note?: string }, now = new Date()) {
  if (acc.actor.type !== 'human') throw forbidden('humans_only', 'Only people can report messages.');
  if (!ULID_RE.test(input.message_id)) throw notFound('message');
  const reasons = reportReasons(acc.file);
  if (!reasons.includes(input.reason)) throw invalid('report_reason_invalid', `Reasons are ${reasons.join(', ')}.`);
  const db = await getDb();
  const [m] = await db.select().from(communityMessages).where(and(eq(communityMessages.id, input.message_id), eq(communityMessages.hengeId, acc.henge.id))).limit(1);
  if (!m || m.deletedAt) throw notFound('message');
  const { channel } = await channelAccess(acc, m.channelId);
  if (m.authorId === acc.actor.id) throw invalid('cannot_report_self', 'You cannot report your own message.');
  const [dto] = await messageDtos(db, [m], null);
  const snapshot = { message: dto, channel: { id: channel.id, name: channel.name }, captured_at: now.toISOString() };
  const [row] = await db
    .insert(communityReports)
    .values({ hengeId: acc.henge.id, kind: 'message', messageId: m.id, channelId: channel.id, targetActorId: m.authorId, reporterId: acc.actor.id, reason: input.reason, note: (input.note ?? '').slice(0, 1000), snapshot, createdAt: now })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new CommunityError(409, 'already_reported', 'You already reported this message.');
  await emit(db, { hengeId: acc.henge.id, kind: 'report.created', payload: { report_id: row.id, message_id: m.id }, audienceCap: 'review_reports' }, now);
  const glyph = m.authorId ? await glyphAutoTimeout(acc.henge.id, acc.file, m.authorId, now) : null;
  return { report_id: row.id, status: row.status, glyph_timeout: glyph };
}

/**
 * Moderation Glyph Rune `auto_timeout`: N distinct reporters about one author within M minutes times the
 * author out for D minutes. The Glyph acts with mod rank and is logged like a person.
 */
export async function glyphAutoTimeout(hengeId: string, f: HengeV1, authorId: string, now = new Date()) {
  const g = moderationGlyph(f)?.autoTimeout;
  if (!g) return null;
  const db = await getDb();
  const [m] = await db.select().from(communityMembers).where(and(eq(communityMembers.hengeId, hengeId), eq(communityMembers.actorId, authorId))).limit(1);
  if (!m || rank(m.roles) >= GLYPH_RANK) return null;
  if (await activeTimeout(db, hengeId, [authorId], now)) return null;
  const since = new Date(now.getTime() - g.windowMinutes * 60_000);
  const [{ n }] = (await db
    .select({ n: sql<number>`count(distinct ${communityReports.reporterId})::int` })
    .from(communityReports)
    .where(and(eq(communityReports.hengeId, hengeId), eq(communityReports.kind, 'message'), eq(communityReports.targetActorId, authorId), eq(communityReports.status, 'open'), gte(communityReports.createdAt, since)))) as [{ n: number }];
  if (n < g.reports) return null;
  const seconds = g.durationMinutes * 60;
  const rune = `Rune: ${g.reports} reports in ${humanDuration(g.windowMinutes * 60)}. Timeout ${humanDuration(seconds)}.`;
  return applyTimeout(db, hengeId, m, seconds, rune, GLYPH_ACTOR, now, rune);
}

export type ReportDto = {
  id: string;
  kind: 'message' | 'appeal';
  status: string;
  reason: string;
  note: string;
  reporter: ReturnType<typeof deletedCard>;
  target: ReturnType<typeof deletedCard> | null;
  message_id: string | null;
  channel_id: string | null;
  snapshot: unknown;
  reports_on_message: number;
  outcome: string | null;
  outcome_note: string | null;
  created_at: string;
  resolved_at: string | null;
};

export async function listReports(acc: Access, q: { status?: string; limit?: number }) {
  requireCap(acc, 'review_reports', 'Your role cannot see the report queue.');
  const status = (q.status ?? 'open') as 'open' | 'dismissed' | 'actioned';
  if (!['open', 'dismissed', 'actioned'].includes(status)) throw invalid('status_invalid', 'Status is open, dismissed or actioned.');
  const db = await getDb();
  const rows = await db
    .select()
    .from(communityReports)
    .where(and(eq(communityReports.hengeId, acc.henge.id), eq(communityReports.status, status)))
    .orderBy(desc(communityReports.createdAt))
    .limit(Math.min(Math.max(q.limit ?? 50, 1), 200));
  const msgIds = [...new Set(rows.map((r) => r.messageId).filter((x): x is string => !!x))];
  const counts = msgIds.length
    ? await db
        .select({ id: communityReports.messageId, n: sql<number>`count(*)::int` })
        .from(communityReports)
        .where(and(inArray(communityReports.messageId, msgIds), eq(communityReports.status, 'open')))
        .groupBy(communityReports.messageId)
    : [];
  const cmap = new Map(counts.map((c) => [c.id, c.n]));
  const cards = await actorCards(db, rows.map((r) => ({ type: 'human', id: r.reporterId })));
  // Targets can be people or agents: resolve both kinds.
  const agentCards = await actorCards(db, rows.filter((r) => r.targetActorId).map((r) => ({ type: 'agent', id: r.targetActorId })));
  const humanCards = await actorCards(db, rows.filter((r) => r.targetActorId).map((r) => ({ type: 'human', id: r.targetActorId })));
  const targetCard = (id: string) => {
    const a = agentCards.get(id);
    if (a && a.type === 'agent') return a;
    return humanCards.get(id) ?? deletedCard(id);
  };
  return {
    items: rows.map(
      (r): ReportDto => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        reason: r.reason,
        note: r.note,
        reporter: cards.get(r.reporterId) ?? deletedCard(r.reporterId),
        target: r.targetActorId ? targetCard(r.targetActorId) : null,
        message_id: r.messageId,
        channel_id: r.channelId,
        snapshot: r.snapshot,
        reports_on_message: r.messageId ? (cmap.get(r.messageId) ?? 0) : 0,
        outcome: r.outcome,
        outcome_note: r.outcomeNote,
        created_at: r.createdAt.toISOString(),
        resolved_at: r.resolvedAt?.toISOString() ?? null,
      }),
    ),
  };
}

export const REPORT_OUTCOMES = ['dismiss', 'delete', 'timeout', 'kick', 'ban', 'lift_ban', 'deny_appeal'] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

const OUTCOME_NOTES: Record<ReportOutcome, string> = {
  dismiss: 'Thanks for your report. A moderator reviewed it and took no action.',
  delete: 'Thanks for your report. A moderator removed the message.',
  timeout: 'Thanks for your report. A moderator removed the message and timed out its author.',
  kick: 'Thanks for your report. A moderator removed the author from this Henge.',
  ban: 'Thanks for your report. A moderator banned the author from this Henge.',
  lift_ban: 'Your appeal was accepted. The ban is lifted and you can join again.',
  deny_appeal: 'Your appeal was reviewed. The ban stays in place.',
};

/**
 * Resolves a report (and every open report on the same message) with an action. Reporters receive a
 * private outcome note. Ban appeals resolve with `lift_ban` or `deny_appeal`.
 */
export async function resolveReport(acc: Access, reportId: string, input: { outcome: string; note?: string; preset?: string; reason?: string; appeal_window_days?: number }, now = new Date()) {
  requireCap(acc, 'review_reports', 'Your role cannot resolve reports.');
  if (!isUuid(reportId)) throw notFound('report');
  const outcome = input.outcome as ReportOutcome;
  if (!REPORT_OUTCOMES.includes(outcome)) throw invalid('outcome_invalid', `Outcomes are ${REPORT_OUTCOMES.join(', ')}.`);
  const db = await getDb();
  const [r] = await db.select().from(communityReports).where(and(eq(communityReports.id, reportId), eq(communityReports.hengeId, acc.henge.id))).limit(1);
  if (!r) throw notFound('report');
  if (r.status !== 'open') throw new CommunityError(409, 'report_resolved', 'That report is already resolved.');
  const appealOutcome = outcome === 'lift_ban' || outcome === 'deny_appeal';
  if ((r.kind === 'appeal') !== appealOutcome) throw invalid('outcome_invalid', r.kind === 'appeal' ? 'Appeals resolve with lift_ban or deny_appeal.' : 'Use lift_ban and deny_appeal only for appeals.');
  const reason = (input.reason ?? `Report: ${r.reason}`).slice(0, 512);

  if (outcome === 'lift_ban') await unban(acc, r.targetActorId!, { reason }, now);
  if (outcome !== 'dismiss' && !appealOutcome && r.messageId) {
    const [m] = await db.select().from(communityMessages).where(eq(communityMessages.id, r.messageId)).limit(1);
    if (m && !m.deletedAt) {
      const { perms } = await channelAccess(acc, m.channelId);
      if (!perms.manage_messages && !can(acc, 'moderate')) throw forbidden('cannot_manage_messages', 'Your role cannot delete messages here.');
      await softDelete(db, m, by(acc), reason, now);
      await audit(db, { hengeId: acc.henge.id, actor: by(acc), action: 'message.deleted', targetType: m.authorType, targetId: m.authorId, reason, payload: { message_id: m.id, report_id: r.id, kept_days: 30 } }, now);
    }
  }
  if (r.targetActorId && !appealOutcome) {
    const still = await db.select().from(communityMembers).where(and(eq(communityMembers.hengeId, acc.henge.id), eq(communityMembers.actorId, r.targetActorId))).limit(1);
    if (still.length) {
      if (outcome === 'timeout') await timeoutMember(acc, r.targetActorId, { preset: input.preset ?? '1h', reason }, now);
      if (outcome === 'kick') await kickMember(acc, r.targetActorId, { reason }, now);
      if (outcome === 'ban') await banMember(acc, r.targetActorId, { reason, appeal_window_days: input.appeal_window_days }, now);
    }
  }
  const note = [OUTCOME_NOTES[outcome], (input.note ?? '').trim().slice(0, 1000)].filter(Boolean).join(' ');
  const status = outcome === 'dismiss' || outcome === 'deny_appeal' ? 'dismissed' : 'actioned';
  const closed = await db
    .update(communityReports)
    .set({ status, outcome, outcomeNote: note, resolvedByType: acc.actor.type, resolvedById: acc.actor.id, resolvedAt: now })
    .where(and(eq(communityReports.hengeId, acc.henge.id), eq(communityReports.status, 'open'), r.messageId ? eq(communityReports.messageId, r.messageId) : eq(communityReports.id, r.id)))
    .returning();
  await audit(db, { hengeId: acc.henge.id, actor: by(acc), action: 'report.resolved', targetType: 'report', targetId: r.id, reason: outcome, payload: { reports: closed.map((c) => c.id), message_id: r.messageId } }, now);
  await emit(db, { hengeId: acc.henge.id, kind: 'report.outcome', payload: { outcome, note, report_ids: closed.map((c) => c.id) }, audience: [...new Set(closed.map((c) => c.reporterId))] }, now);
  return { resolved: closed.map((c) => c.id), outcome, status };
}

/** The reporter's own reports with their private outcome notes. */
export async function myReports(acc: Access) {
  const db = await getDb();
  const rows = await db.select().from(communityReports).where(and(eq(communityReports.hengeId, acc.henge.id), eq(communityReports.reporterId, acc.actor.id))).orderBy(desc(communityReports.createdAt)).limit(100);
  return { items: rows.map((r) => ({ id: r.id, kind: r.kind, reason: r.reason, status: r.status, outcome: r.outcome, outcome_note: r.outcomeNote, message_id: r.messageId, created_at: r.createdAt.toISOString(), resolved_at: r.resolvedAt?.toISOString() ?? null })) };
}

/** A banned member appeals inside the appeal window. One open appeal per ban. */
export async function appealBan(actor: Actor, hengeId: string, input: { text: string }, now = new Date()) {
  if (actor.type !== 'human') throw forbidden('humans_only', 'Only people can appeal.');
  const db = await getDb();
  const henge = await loadHenge(db, hengeId);
  const ban = await activeBan(db, henge.id, [actor.id]);
  if (!ban) throw notFound('ban');
  if (!ban.appealUntil || ban.appealUntil <= now) throw forbidden('appeal_window_closed', 'The appeal window for this ban is closed.');
  const text = (input.text ?? '').trim();
  if (text.length < 1 || text.length > 2000) throw invalid('appeal_text_invalid', 'Write your appeal in 1 to 2000 characters.');
  const open = await db.select().from(communityReports).where(and(eq(communityReports.hengeId, henge.id), eq(communityReports.kind, 'appeal'), eq(communityReports.reporterId, actor.id), eq(communityReports.status, 'open'))).limit(1);
  if (open.length) throw new CommunityError(409, 'appeal_open', 'Your appeal is waiting for a moderator.');
  const [row] = await db
    .insert(communityReports)
    .values({ hengeId: henge.id, kind: 'appeal', messageId: null, targetActorId: actor.id, reporterId: actor.id, reason: 'appeal', note: text, snapshot: { ban_reason: ban.reason, banned_at: ban.createdAt.toISOString() }, createdAt: now })
    .returning();
  await emit(db, { hengeId: henge.id, kind: 'report.created', payload: { report_id: row!.id, kind: 'appeal' }, audienceCap: 'review_reports' }, now);
  return { appeal_id: row!.id, status: 'open' };
}

/* ---------------------------------------------------------------------------------------------- */
/* Audit log (mockup 17)                                                                           */
/* ---------------------------------------------------------------------------------------------- */

export async function readAuditLog(acc: Access, q: { actor?: string; action?: string; before?: string; limit?: number }) {
  requireCap(acc, 'read_audit_log', 'Your role cannot read the audit log.');
  if (q.before !== undefined && !ULID_RE.test(q.before)) throw invalid('cursor_invalid', 'Cursors are audit entry ids.');
  const db = await getDb();
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const rows = await db
    .select()
    .from(communityAuditLog)
    .where(
      and(
        eq(communityAuditLog.hengeId, acc.henge.id),
        q.actor ? eq(communityAuditLog.actorId, q.actor) : undefined,
        q.action ? eq(communityAuditLog.action, q.action) : undefined,
        q.before ? lt(communityAuditLog.id, q.before) : undefined,
      ),
    )
    .orderBy(desc(communityAuditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const refs = page.flatMap((r) => [
    { type: r.actorType, id: r.actorId },
    ...(r.targetId && (r.targetType === 'human' || r.targetType === 'agent') ? [{ type: r.targetType, id: r.targetId }] : []),
  ]);
  const cards = await actorCards(db, refs);
  return {
    items: page.map((r) => ({
      id: r.id,
      actor: cards.get(r.actorId) ?? deletedCard(r.actorId),
      action: r.action,
      target_type: r.targetType,
      target_id: r.targetId,
      target: r.targetId ? (cards.get(r.targetId) ?? null) : null,
      reason: r.reason,
      payload: r.payload as Record<string, unknown>,
      created_at: r.createdAt.toISOString(),
    })),
    next_before: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}
