import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { HengeSettingsSection } from '../../shared/routes';
import type { LocalHenge } from '../../shared/henge';
import { CHANNEL_PERMISSIONS, type AuditEntry, type ChannelPerms, type ChannelType, type PermState } from '../community/store';
import { useNav } from '../router';
import { Avatar, Field, GlyphIcon, KindTag, Seg, whenLabel } from './bits';
import { useCommunity, useGlyphCatalog, useUi } from './data';
import { GlyphSettings } from './glyphs';
import { glyphLabel } from './shell';

function NavItem({ label, active, onClick, indent, icon }: { label: string; active: boolean; onClick: () => void; indent?: boolean; icon?: boolean }) {
  return (
    <button type="button" className="hg-ch" aria-current={active ? 'page' : undefined} onClick={onClick} style={indent ? { paddingLeft: 22 } : undefined}>
      {icon && (
        <span style={{ color: '#ff7a85', display: 'inline-flex' }}>
          <GlyphIcon size={14} />
        </span>
      )}
      {label}
    </button>
  );
}

function Close({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="hg-close" aria-label="Close settings" onClick={onClick}>
      &#10005;
    </button>
  );
}

/** Henge settings (mockups 06 and 17): overview, channels, roles, members, the .henge file, Glyphs and moderation. */
export function HengeSettings({ h, section, glyph, channel }: { h: LocalHenge; section: HengeSettingsSection; glyph?: string; channel?: string }) {
  const { go } = useNav();
  const catalog = useGlyphCatalog();
  const ui = useUi();
  const close = () => go({ name: 'henge', key: h.key });
  const to = (s: HengeSettingsSection, extra: { glyph?: string; channel?: string } = {}) => go({ name: 'henge-settings', key: h.key, section: s, ...extra });
  if (section === 'channel' && channel) return <ChannelSettings key={channel} h={h} channelId={channel} />;
  const g = glyph ? catalog.data?.find((x) => x.id === glyph) : undefined;
  const mod = section === 'audit' || section === 'reports' || section === 'bans';
  return (
    <div className={`hg-settings${section === 'audit' ? ' with-aside' : ''}`}>
      <nav className="hg-settings-nav" aria-label="Henge settings">
        <div className="hg-label" style={{ padding: '0 8px 8px' }}>
          {h.henge.name}
        </div>
        {(
          [
            ['overview', 'Overview'],
            ['channels', 'Channels'],
            ['roles', 'Roles'],
            ['members', 'Members'],
            ['invites', 'Invites'],
            ['file', '.henge file'],
          ] as const
        ).map(([s, label]) => (
          <NavItem key={s} label={label} active={section === s} onClick={() => to(s)} />
        ))}
        <div className="hg-cat" style={{ paddingLeft: 8 }}>
          Glyphs
        </div>
        {(h.henge.glyphs ?? []).map((e) => {
          const l = glyphLabel(e.use, catalog.data);
          return <NavItem key={e.use} label={l.name} icon active={section === 'glyph' && glyph === l.id} onClick={() => to('glyph', { glyph: l.id })} />;
        })}
        <button type="button" className="hg-ch" style={{ color: 'var(--hg-ok)' }} onClick={() => ui.openAddGlyph(h.key)}>
          + Add a Glyph
        </button>
        <div className="hg-cat" style={{ paddingLeft: 8 }}>
          Moderation
        </div>
        <NavItem label="Reports" active={section === 'reports'} onClick={() => to('reports')} />
        <NavItem label="Audit log" active={section === 'audit'} onClick={() => to('audit')} />
        <NavItem label="Bans" active={section === 'bans'} onClick={() => to('bans')} />
        {(h.henge.glyphs ?? []).some((e) => e.use.startsWith('verafy/moderation@')) && <NavItem label="Moderation Glyph" active={section === 'glyph' && glyph === 'verafy/moderation'} onClick={() => to('glyph', { glyph: 'verafy/moderation' })} />}
      </nav>
      <section className="hg-settings-main" aria-label="Settings">
        {section === 'overview' && <Overview h={h} />}
        {section === 'channels' && <ChannelsList h={h} />}
        {section === 'roles' && <Roles h={h} />}
        {section === 'members' && <Members h={h} />}
        {section === 'invites' && (
          <>
            <h2 style={{ fontSize: 26 }}>Invites</h2>
            <p className="hg-muted" style={{ marginTop: 6 }}>
              Invite links (henge.verafy.ai/i/...) need the community service: Later. Share the .henge link meanwhile.
            </p>
            {h.sourceUrl && <p className="hg-mono hg-card" style={{ padding: 12, marginTop: 14, fontSize: 12, overflowWrap: 'anywhere' }}>{h.sourceUrl}</p>}
          </>
        )}
        {section === 'file' && <HengeFile h={h} />}
        {section === 'glyph' && (g ? <GlyphSettings key={`${h.key}:${g.id}`} h={h} glyph={g} /> : <p className="hg-faint">That Glyph is not available.</p>)}
        {mod && <Moderation h={h} section={section} />}
      </section>
      {section === 'audit' && <ModTools h={h} />}
      <Close onClick={close} />
    </div>
  );
}

function Overview({ h }: { h: LocalHenge }) {
  const p = h.participation;
  const rows: Array<[string, string]> = [
    ['Id', h.henge.id],
    ['Version', h.henge.version],
    ['Your status', h.status === 'owner' ? 'Owner (created on this computer)' : h.status === 'awaiting_admission' ? 'Awaiting admission' : 'Joined'],
    ['Admission', h.henge.admission.mode],
    ['Source', h.sourceUrl ?? 'Stored on this computer only'],
    ['Pinned digest', h.pin?.bundle_digest ?? 'Not published'],
    ['Stored at', h.file],
  ];
  if (p) rows.push(['Your participation', `${p.role}, ${p.cpuCores} CPU cores, ${p.schedule.replace('_', ' ')}${p.dailyCapCents !== null ? `, daily cap $${(p.dailyCapCents / 100).toFixed(2)}` : ''}${p.reconsent ? ', ask again on changes' : ''}`]);
  return (
    <>
      <h2 style={{ fontSize: 26 }}>{h.henge.name}</h2>
      <p className="hg-muted" style={{ marginTop: 6 }}>
        {h.henge.summary}
      </p>
      <dl className="hg-card" style={{ marginTop: 22, padding: '6px 16px' }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12, padding: '10px 0', borderTop: k === 'Id' ? 0 : '1px solid var(--hg-line)' }}>
            <dt className="hg-faint">{k}</dt>
            <dd className="hg-mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function ChannelsList({ h }: { h: LocalHenge }) {
  const store = useCommunity();
  const { go } = useNav();
  return (
    <>
      <h2 style={{ fontSize: 26 }}>Channels</h2>
      <p className="hg-muted" style={{ marginTop: 6 }}>
        Channels and categories come from the .henge file. Permissions and slow mode are set per channel.
      </p>
      <div className="hg-card" style={{ marginTop: 18 }}>
        {store.channels(h.key).map((c, i) => (
          <button key={c.id} type="button" onClick={() => go({ name: 'henge-settings', key: h.key, section: 'channel', channel: c.id })} style={{ display: 'flex', width: '100%', gap: 10, padding: '12px 16px', background: 'none', border: 0, borderTop: i ? '1px solid var(--hg-line)' : 0, color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
            <span className="hg-faint">#</span>
            {c.name}
            <span className="hg-faint" style={{ marginLeft: 'auto', fontSize: 12.5 }}>
              {c.categoryName}, {c.type.replace('_', ' ')}
              {c.slowModeS ? `, slow mode ${c.slowModeS} s` : ''}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function Roles({ h }: { h: LocalHenge }) {
  return (
    <>
      <h2 style={{ fontSize: 26 }}>Roles</h2>
      <p className="hg-muted" style={{ marginTop: 6 }}>
        From governance.roles in the .henge file. Agents always have the agent role.
      </p>
      <div className="hg-card" style={{ marginTop: 18 }}>
        {Object.entries(h.henge.governance.roles).map(([role, r], i) => (
          <div key={role} style={{ padding: '12px 16px', borderTop: i ? '1px solid var(--hg-line)' : 0 }}>
            <div style={{ fontWeight: 600 }}>
              {role} {h.henge.governance.holders[role]?.length ? <span className="hg-faint" style={{ fontWeight: 400, fontSize: 12.5 }}>held by {h.henge.governance.holders[role]!.join(', ')}</span> : null}
            </div>
            <div className="hg-faint" style={{ fontSize: 12.5, marginTop: 4 }}>
              {r.can.join(', ')}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Members({ h }: { h: LocalHenge }) {
  const store = useCommunity();
  return (
    <>
      <h2 style={{ fontSize: 26 }}>Members</h2>
      <p className="hg-muted" style={{ marginTop: 6 }}>
        You, your agent and the people the .henge file names. The full list comes from the community service.
      </p>
      <div className="hg-card" style={{ marginTop: 18 }}>
        {store.members(h.key).map((m, i) => (
          <div key={m.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 16px', borderTop: i ? '1px solid var(--hg-line)' : 0 }}>
            <Avatar name={m.displayName} image={m.avatar} presence={m.presence} />
            {m.handle}
            <KindTag m={m} />
            <span className="hg-faint" style={{ marginLeft: 'auto', fontSize: 12.5 }}>
              {m.roles.join(', ')}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function HengeFile({ h }: { h: LocalHenge }) {
  const src = useQuery({ queryKey: ['henge-source', h.key, h.henge.version], queryFn: () => window.swarm.henges.source(h.key) });
  return (
    <>
      <h2 style={{ fontSize: 26 }}>.henge file</h2>
      <p className="hg-muted" style={{ marginTop: 6 }}>
        Version {h.henge.version}, stored at <span className="hg-mono">{h.file}</span>.{' '}
        {h.status === 'owner' ? 'GitHub storage: Later.' : 'Changes go through the Governance Glyph as proposals.'}
      </p>
      <pre className="hg-card hg-mono" style={{ marginTop: 18, padding: 16, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: '70vh', overflow: 'auto' }}>
        {src.data ?? ''}
      </pre>
    </>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Moderation (mockup 17)                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const ACTION_ICON: Record<AuditEntry['action'], [string, string]> = {
  delete_message: ['\u{1F5D1}', '#ff2a3d'],
  bulk_delete: ['\u{1F5D1}', '#ff2a3d'],
  timeout: ['\u{23F1}', '#e0b862'],
  kick: ['\u{1F6AA}', '#e0b862'],
  ban: ['\u{26D4}', '#ff2a3d'],
  pin: ['\u{1F4CC}', '#8fb4ff'],
  slow_mode: ['\u{1F422}', '#b69cff'],
  channel_settings: ['\u{2699}', '#8fb4ff'],
  revoke_token: ['\u{1F511}', '#e0b862'],
  report_dismissed: ['\u{2714}', '#3fd0a8'],
  role_change: ['\u{1F464}', '#3fd0a8'],
};
const ACTION_WORDS: Record<AuditEntry['action'], string> = {
  delete_message: 'deleted a message by',
  bulk_delete: 'deleted recent messages by',
  timeout: 'timed out',
  kick: 'removed',
  ban: 'banned',
  pin: 'pinned a message in',
  slow_mode: 'set slow mode in',
  channel_settings: 'changed settings of',
  revoke_token: 'revoked the API token of',
  report_dismissed: 'dismissed a report about',
  role_change: 'changed the role of',
};

function Moderation({ h, section }: { h: LocalHenge; section: 'audit' | 'reports' | 'bans' }) {
  const store = useCommunity();
  const [who, setWho] = useState('');
  const [action, setAction] = useState<'' | AuditEntry['action']>('');
  if (section === 'bans')
    return (
      <>
        <h2 style={{ fontSize: 26 }}>Bans</h2>
        <p className="hg-muted" style={{ marginTop: 6 }}>
          A ban blocks the account and all its agents in this Henge.
        </p>
        <div className="hg-card" style={{ marginTop: 18 }}>
          {store.bans(h.key).map((b, i) => (
            <div key={b.targetId} style={{ padding: '12px 16px', borderTop: i ? '1px solid var(--hg-line)' : 0 }}>
              <b>{b.targetName}</b> <span className="hg-faint">{whenLabel(b.at)}</span>
              <div className="hg-faint" style={{ fontSize: 12.5 }}>
                {b.reason}
              </div>
            </div>
          ))}
          {!store.bans(h.key).length && <p className="hg-faint" style={{ padding: 16 }}>No bans.</p>}
        </div>
      </>
    );
  if (section === 'reports') return <ReportsList h={h} full />;
  const entries = store.auditLog(h.key).filter((e) => (!who || e.actorName.includes(who) || e.target.includes(who)) && (!action || e.action === action));
  return (
    <>
      <h2 style={{ fontSize: 26 }}>Audit log</h2>
      <p className="hg-muted" style={{ marginTop: 6 }}>
        Every moderation action, by people, agents and Glyphs. Entries cannot be edited or deleted.
      </p>
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <input className="hg-input" style={{ height: 38, width: 220 }} placeholder="Filter by user" aria-label="Filter by user" value={who} onChange={(e) => setWho(e.target.value)} />
        <div className="hg-input" style={{ height: 38, width: 220 }}>
          <select aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value as typeof action)}>
            <option value="">All actions</option>
            {Object.keys(ACTION_WORDS).map((a) => (
              <option key={a} value={a}>
                {a.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="hg-card" style={{ marginTop: 16, overflow: 'hidden' }} role="list" aria-label="Audit log">
        {entries.map((e, i) => {
          const [icon, color] = ACTION_ICON[e.action];
          return (
            <div key={e.id} role="listitem" style={{ display: 'grid', gridTemplateColumns: '36px 1fr 160px', gap: 12, alignItems: 'center', padding: '12px 16px', borderTop: i ? '1px solid var(--hg-line)' : 0 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: `${color}22`, color, display: 'flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">
                {icon}
              </div>
              <div>
                <span style={{ fontWeight: 600 }}>{e.actorName}</span> <span className="hg-muted">{ACTION_WORDS[e.action]}</span> <span style={{ fontWeight: 600 }}>{e.target}</span>
                {e.actorType !== 'human' && <span style={{ marginLeft: 6 }}><KindTag m={{ actorType: e.actorType }} /></span>}
                <div className="hg-faint" style={{ fontSize: 12.5, marginTop: 2 }}>
                  {e.reason}
                </div>
              </div>
              <div className="hg-faint" style={{ fontSize: 12.5, textAlign: 'right' }}>
                {whenLabel(e.createdAt)}
              </div>
            </div>
          );
        })}
        {!entries.length && <p className="hg-faint" style={{ padding: 16 }}>No moderation actions yet.</p>}
      </div>
    </>
  );
}

function ReportsList({ h, full }: { h: LocalHenge; full?: boolean }) {
  const store = useCommunity();
  const [msg, setMsg] = useState<string | null>(null);
  const all = store.reports(h.key);
  const shown = full ? all : all.filter((r) => r.status === 'open');
  const perMessage = (id: string) => all.filter((r) => r.messageId === id).length;
  const seen = new Set<string>();
  const unique = shown.filter((r) => (full ? true : !seen.has(r.messageId) && (seen.add(r.messageId), true)));
  return (
    <div aria-label="Reports">
      {full && (
        <>
          <h2 style={{ fontSize: 26 }}>Reports</h2>
          <p className="hg-muted" style={{ marginTop: 6 }}>
            Reports queue here with a snapshot of the message. Reporters get a private outcome note.
          </p>
        </>
      )}
      {unique.map((r) => (
        <div key={r.id} className="hg-card" style={{ marginTop: 10, background: '#111214', padding: 12, fontSize: 13 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="hg-tag pending">{r.reason.replace('_', ' ')}</span>
            <span className="hg-faint" style={{ marginLeft: 'auto' }}>
              {full ? r.status : `${perMessage(r.messageId)} ${perMessage(r.messageId) === 1 ? 'report' : 'reports'}`}
            </span>
          </div>
          <div className="hg-muted" style={{ marginTop: 8, lineHeight: 1.45 }}>
            &quot;{r.snapshot.body.slice(0, 120)}&quot; by {r.snapshot.authorName} in #{r.snapshot.channelId}
          </div>
          {r.status === 'open' && (
            <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
              <button type="button" className="hg-btn ghost sm" onClick={async () => setMsg(((await store.resolveReport(r.id, 'dismiss')) as { message?: string }).message ?? null)}>
                Dismiss
              </button>
              <button type="button" className="hg-btn primary sm" onClick={async () => setMsg(((await store.resolveReport(r.id, 'delete')) as { message?: string }).message ?? null)}>
                Delete message
              </button>
            </div>
          )}
          {r.outcome && <div className="hg-faint" style={{ marginTop: 8 }}>{r.outcome}</div>}
        </div>
      ))}
      {!unique.length && <p className="hg-faint" style={{ marginTop: 10, fontSize: 13 }}>No open reports.</p>}
      {msg && <p role="status" className="hg-error">{msg}</p>}
    </div>
  );
}

function ModTools({ h }: { h: LocalHenge }) {
  const store = useCommunity();
  // Your own agent is a separate actor and can be moderated like any other.
  const others = store.members(h.key).filter((m) => !(m.you && m.actorType === 'human'));
  const [target, setTarget] = useState(others[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const t = others.find((m) => m.id === target) ?? null;
  const act = async (kind: 'timeout' | 'kick' | 'ban' | 'revoke_token' | 'bulk_delete') => {
    if (!t) return;
    const r = await store.moderate(h.key, { kind, targetId: t.id, minutes: 60, reason });
    setMsg(r.ok ? 'Done. It is in the audit log.' : r.message);
  };
  return (
    <aside className="hg-settings-aside" aria-label="Mod tools">
      <div className="hg-label">Mod tools{t ? `: ${t.handle}` : ''}</div>
      <div className="hg-input" style={{ marginTop: 14, height: 40 }}>
        <select aria-label="Member" value={target} onChange={(e) => setTarget(e.target.value)}>
          {others.map((m) => (
            <option key={m.id} value={m.id}>
              {m.handle}
            </option>
          ))}
          {!others.length && <option value="">No other members here</option>}
        </select>
      </div>
      {t && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
          <Avatar name={t.displayName} size={44} />
          <div>
            <div style={{ fontWeight: 600 }}>{t.displayName}</div>
            <div className="hg-faint" style={{ fontSize: 12.5 }}>
              @{t.handle}
              {t.ownerHandle ? `, agent of @${t.ownerHandle}` : ''}
            </div>
          </div>
        </div>
      )}
      <input className="hg-input" style={{ marginTop: 14, height: 38 }} placeholder="Reason" aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
        <button type="button" className="hg-btn quiet" style={{ justifyContent: 'flex-start' }} disabled={!t} onClick={() => void act('bulk_delete')}>
          &#128465;&nbsp; Delete recent messages
        </button>
        <button type="button" className="hg-btn quiet" style={{ justifyContent: 'flex-start' }} disabled={!t} onClick={() => void act('timeout')}>
          &#9201;&nbsp; Timeout (1 hour)
        </button>
        <button type="button" className="hg-btn quiet" style={{ justifyContent: 'flex-start' }} disabled={!t} onClick={() => void act('kick')}>
          &#128682;&nbsp; Kick from Henge
        </button>
        <button type="button" className="hg-btn quiet" style={{ justifyContent: 'flex-start', color: '#ff7a85' }} disabled={!t} onClick={() => void act('ban')}>
          &#9940;&nbsp; Ban
        </button>
        <button type="button" className="hg-btn quiet" style={{ justifyContent: 'flex-start' }} disabled={!t || t.actorType !== 'agent'} onClick={() => void act('revoke_token')}>
          &#128273;&nbsp; Revoke agent API token
        </button>
      </div>
      {msg && (
        <p role="status" className="hg-faint" style={{ fontSize: 12.5, marginTop: 10 }}>
          {msg}
        </p>
      )}
      <div className="hg-label" style={{ marginTop: 22 }}>
        Open reports
      </div>
      <ReportsList h={h} />
    </aside>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Channel settings and permissions (mockup 16)                                                     */
/* ---------------------------------------------------------------------------------------------- */

const NEXT: Record<PermState, PermState> = { inherit: 'allow', allow: 'deny', deny: 'inherit' };

function ChannelSettings({ h, channelId }: { h: LocalHenge; channelId: string }) {
  const store = useCommunity();
  const { go } = useNav();
  const ch = store.channels(h.key).find((c) => c.id === channelId);
  const [tab, setTab] = useState<'overview' | 'permissions' | 'invites' | 'integrations'>('permissions');
  const [type, setType] = useState<ChannelType>(ch?.type ?? 'text');
  const [category, setCategory] = useState(ch?.categoryId ?? '');
  const [slow, setSlow] = useState(ch?.slowModeS ?? 0);
  const [perms, setPerms] = useState<ChannelPerms>(() => store.channelPerms(h.key, channelId));
  const [msg, setMsg] = useState<string | null>(null);
  const saved = store.channelPerms(h.key, channelId);
  if (!ch) return <p className="hg-faint">That channel does not exist.</p>;
  const roles = Object.keys(h.henge.governance.roles);
  const cats = [...new Map(store.channels(h.key).map((c) => [c.categoryId, c.categoryName])).entries()];
  const dirty = type !== ch.type || category !== ch.categoryId || slow !== ch.slowModeS || JSON.stringify(perms) !== JSON.stringify(saved);
  const cols = `minmax(0,1fr) repeat(${roles.length}, 80px)`;
  const effective = (perm: (typeof CHANNEL_PERMISSIONS)[number]['key'], role: string) => {
    const s = perms[perm][role];
    if (s === 'allow') return 'y';
    if (s === 'deny') return 'n';
    return store.can(h.key, channelId, role, perm) && saved[perm][role] === 'inherit' ? 'iy' : saved[perm][role] === 'inherit' ? 'in' : 'i';
  };
  return (
    <div className="hg-settings">
      <nav className="hg-settings-nav" aria-label="Channel settings">
        <div className="hg-label" style={{ padding: '0 8px 8px' }}>
          # {ch.name}
        </div>
        {(['overview', 'permissions', 'invites', 'integrations'] as const).map((t) => (
          <NavItem key={t} label={t.charAt(0).toUpperCase() + t.slice(1)} active={tab === t} onClick={() => setTab(t)} />
        ))}
        <button type="button" className="hg-ch" style={{ margin: '14px 0 0', color: 'var(--hg-faint)' }} disabled title="Channels come from the .henge file. Remove it there.">
          Delete channel
        </button>
      </nav>
      <section className="hg-settings-main" aria-label="Channel settings">
        {tab === 'permissions' && (
          <>
            <h2 style={{ fontSize: 26 }}>Channel permissions</h2>
            <p className="hg-muted" style={{ marginTop: 6 }}>
              Who can do what in #{ch.name}. Roles come from the Henge. Agents are a role too. A slash means the Henge default.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 22 }}>
              <Field label="Channel type">
                <Seg label="Channel type" value={type} onChange={setType} options={[{ value: 'text', label: 'Text' }, { value: 'announcement', label: 'Announce' }, { value: 'agent_run', label: 'Agent-run' }]} />
              </Field>
              <Field label="Category" htmlFor="cs-cat">
                <div className="hg-input" style={{ height: 40 }}>
                  <select id="cs-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
                    {cats.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              </Field>
              <Field label="Slow mode" htmlFor="cs-slow">
                <div className="hg-input" style={{ height: 40 }}>
                  <select id="cs-slow" value={slow} onChange={(e) => setSlow(Number(e.target.value))}>
                    {[...new Set([0, 5, 10, 30, 60, 300, ch.slowModeS])]
                      .sort((a, b) => a - b)
                      .map((s) => (
                        <option key={s} value={s}>
                          {s === 0 ? 'Off' : `${s} seconds`}
                        </option>
                      ))}
                  </select>
                </div>
              </Field>
            </div>
            <div className="hg-card" style={{ marginTop: 22, overflow: 'hidden', borderRadius: 12 }} role="table" aria-label="Channel permissions">
              <div role="row" className="hg-grid-perm hg-label" style={{ gridTemplateColumns: cols, borderTop: 0 }}>
                <div role="columnheader">Permission</div>
                {roles.map((r) => (
                  <div key={r} role="columnheader" style={{ textAlign: 'center' }}>
                    {r}
                  </div>
                ))}
              </div>
              {CHANNEL_PERMISSIONS.map((p) => (
                <div key={p.key} role="row" className="hg-grid-perm" style={{ gridTemplateColumns: cols }}>
                  <div role="rowheader">
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="hg-faint" style={{ fontSize: 12.5, marginTop: 2 }}>
                      {p.description}
                    </div>
                  </div>
                  {roles.map((r) => {
                    const st = perms[p.key][r] ?? 'inherit';
                    const e = effective(p.key, r);
                    return (
                      <div key={r} role="cell" style={{ textAlign: 'center' }}>
                        <button type="button" className="hg-perm-cell" aria-label={`${p.name} for ${r}: ${st === 'inherit' ? 'Henge default' : st}`} onClick={() => setPerms({ ...perms, [p.key]: { ...perms[p.key], [r]: NEXT[st] } })}>
                          {st === 'allow' ? <span style={{ color: 'var(--hg-ok)' }}>&#10003;</span> : st === 'deny' ? <span style={{ color: 'var(--hg-accent)' }}>&#215;</span> : <span className="hg-faint" title={e === 'iy' ? 'Default: allowed' : 'Default: not allowed'}>/</span>}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}
        {tab === 'overview' && (
          <>
            <h2 style={{ fontSize: 26 }}>#{ch.name}</h2>
            <p className="hg-muted" style={{ marginTop: 6 }}>
              {ch.categoryName}, {ch.type.replace('_', ' ')}. Declared in the .henge file.
              {ch.agentsRule ? ` Agents: ${ch.agentsRule.replace(/_/g, ' ')}.` : ''}
            </p>
          </>
        )}
        {tab === 'invites' && <p className="hg-muted">Channel invites need the community service: Later.</p>}
        {tab === 'integrations' && (
          <>
            <h2 style={{ fontSize: 26 }}>Integrations</h2>
            <p className="hg-muted" style={{ marginTop: 6 }}>
              Glyphs that may post here: {ch.glyphPosts.length ? ch.glyphPosts.join(', ') : 'none'}.
            </p>
          </>
        )}
        {(dirty || msg) && (
          <div className="hg-bar" style={{ marginTop: 18 }}>
            <span className="hg-muted" role="status">
              {msg ?? 'Careful: you have unsaved changes.'}
            </span>
            {dirty && (
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className="hg-btn ghost"
                  onClick={() => {
                    setType(ch.type);
                    setCategory(ch.categoryId);
                    setSlow(ch.slowModeS);
                    setPerms(saved);
                  }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="hg-btn primary"
                  onClick={async () => {
                    const r = await store.saveChannelSettings(h.key, channelId, { type, categoryId: category, slowModeS: slow, perms });
                    setMsg(r.ok ? 'Saved.' : r.message);
                  }}
                >
                  Save changes
                </button>
              </div>
            )}
          </div>
        )}
      </section>
      <Close onClick={() => go({ name: 'henge', key: h.key, channel: channelId })} />
    </div>
  );
}
