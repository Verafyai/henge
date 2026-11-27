import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LocalHenge } from '../../shared/henge';
import { useAppInfo, useAuth, useHealth, useMe, useNode, useNodeActions } from '../api';
import type { Channel, Member } from '../community/store';
import { useNav } from '../router';
import { Avatar, GlyphIcon, initialsOf, KindTag, Mark, PRESENCE_LABEL, tintFor } from './bits';
import { useCommunity, useGlyphCatalog, useLocalHenges, useUi } from './data';

/** `<publisher>/<glyph>@<range>`, as in the schema package (kept here so the renderer does not bundle the validators). */
export function parseGlyphUse(use: string): { id: string; slug: string } | null {
  const m = /^([a-z0-9-]+)\/([a-z0-9-]+)@/.exec(use);
  return m ? { id: `${m[1]}/${m[2]}`, slug: m[2]! } : null;
}

export function hengeIconText(h: LocalHenge): string {
  const t = h.henge.landing['x-henge-icon-text'];
  return typeof t === 'string' && t.trim() ? t.trim().slice(0, 2).toUpperCase() : initialsOf(h.henge.name);
}

/** Closes on outside click and Escape. */
export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return ref;
}

/** macOS only: the window has an inset title bar, so a thin drag strip stays above the layout. */
export function TitleStrip() {
  const info = useAppInfo();
  const health = useHealth();
  if (info.data?.platform !== 'darwin') return null;
  const online = health.isSuccess;
  return (
    <div className="app-drag" style={{ height: 28, flex: 'none', display: 'flex', alignItems: 'center', paddingLeft: 80, paddingRight: 14, fontSize: 11.5, color: 'var(--hg-faint)', background: 'var(--hg-rail)', borderBottom: '1px solid #121316' }}>
      <span style={{ flex: 1, textAlign: 'center' }}>
        Henge v{info.data.version} ({info.data.channel})
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }} data-testid="api-status">
        <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: online ? 'var(--hg-ok)' : 'transparent', border: online ? 0 : '1px solid var(--hg-faint)' }} />
        {online ? 'Online' : 'Offline'}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Rail                                                                                             */
/* ---------------------------------------------------------------------------------------------- */

export function Rail({ preview }: { preview?: LocalHenge }) {
  const { route, go } = useNav();
  const henges = useLocalHenges();
  const store = useCommunity();
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useDismiss<HTMLDivElement>(addOpen, () => setAddOpen(false));
  const list = [...(henges.data ?? [])];
  if (preview && !list.some((h) => h.key === preview.key)) list.push(preview);
  const selected = preview?.key ?? (route.name === 'henge' ? route.key : null);
  return (
    <nav className="hg-rail" aria-label="Henges">
      <button type="button" className={`hg-hicon${selected ? '' : ' sel'}`} style={{ background: selected ? 'var(--hg-raise)' : undefined }} aria-label="Home" aria-current={selected ? undefined : 'page'} onClick={() => go({ name: 'home' })}>
        {!selected && <span className="pip" />}
        <Mark height={30} />
      </button>
      <div className="sep" />
      {list.map((h) => {
        const sel = h.key === selected;
        const u = store.hengeUnread(h.key);
        const [bg, fg] = tintFor(h.key);
        return (
          <button
            key={h.key}
            type="button"
            className={`hg-hicon${sel ? ' sel' : ''}`}
            style={sel ? undefined : { background: bg, color: fg }}
            aria-label={`${h.henge.name}${u.mentions ? `, ${u.mentions} mentions` : u.count ? ', unread messages' : ''}`}
            aria-current={sel ? 'page' : undefined}
            title={h.henge.name}
            onClick={() => go({ name: 'henge', key: h.key })}
          >
            {(sel || u.count > 0) && <span className="pip" />}
            {hengeIconText(h)}
            {u.mentions > 0 && <span className="hg-badge">{u.mentions}</span>}
          </button>
        );
      })}
      <div style={{ position: 'relative' }} ref={addRef}>
        <button type="button" className="hg-hicon add" aria-label="Add a Henge" aria-expanded={addOpen} onClick={() => setAddOpen((o) => !o)}>
          +
        </button>
        {addOpen && (
          <div className="hg-menu" style={{ left: 60, top: 0 }} role="menu" aria-label="Add a Henge">
            <button type="button" role="menuitem" onClick={() => (setAddOpen(false), go({ name: 'add-henge' }))}>
              Join with a .henge link
            </button>
            <button type="button" role="menuitem" onClick={() => (setAddOpen(false), go({ name: 'create-henge' }))}>
              Create a Henge
            </button>
          </div>
        )}
      </div>
      <button type="button" className="hg-hicon tool" aria-label="Discover swarms" title="Discover swarms" onClick={() => go({ name: 'store' })}>
        &#8595;
      </button>
      <div style={{ flex: 1 }} />
      <button type="button" className="hg-hicon tool" aria-label="User settings" title="User settings" onClick={() => go({ name: 'user-settings' })}>
        &#9881;
      </button>
    </nav>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* User panel                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

const MODE_LABEL = { local: 'Local', api: 'API key', hybrid: 'Hybrid' } as const;

/** Local node state in words (SPEC 4.2): specific, never claiming work that is not running. */
export function useNodeState() {
  const node = useNode();
  const health = useHealth();
  const online = health.isSuccess;
  const o = node.data;
  const t = o?.tasks;
  const kill = o?.kill;
  if (kill?.global) return { label: 'Stopped by Verafy', detail: kill.global.reason, tone: 'var(--hg-accent)' };
  if (kill?.swarms[0]) return { label: 'Stopped by Verafy', detail: `work for ${kill.swarms[0].swarm}: ${kill.swarms[0].reason}`, tone: 'var(--hg-accent)' };
  if (o?.paused) return { label: o.pausedLabel ?? 'Paused', detail: 'nothing will run until you resume', tone: 'var(--hg-pending)' };
  if (t?.current) return { label: 'Running', detail: `a task for ${t.current.swarm} on ${t.current.model}`, tone: 'var(--hg-ok)' };
  if (t && t.phase !== 'off') return { label: t.phase === 'blocked' ? 'Waiting' : 'Ready', detail: t.detail, tone: online ? 'var(--hg-ok)' : '#55575d' };
  if (o?.setup) return { label: 'Set up', detail: 'no swarm joined yet', tone: online ? 'var(--hg-ok)' : '#55575d' };
  return { label: 'Node not set up', detail: 'nothing runs on this computer yet', tone: '#55575d' };
}

export function UserPanel() {
  const auth = useAuth();
  const me = useMe();
  const store = useCommunity();
  const node = useNode();
  const actions = useNodeActions();
  const { go } = useNav();
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);
  const ref = useDismiss<HTMLDivElement>(menu, () => setMenu(false));
  const state = useNodeState();
  const o = node.data;
  const profile = store.myProfile();
  const signedIn = auth.status === 'signed_in' && me.data;
  const name = profile?.displayName ?? (signedIn ? me.data!.handle : 'you');
  const paused = o?.paused ?? false;
  const model = o?.models.installed.find((m) => m.contentHash === o.models.storage.activeModel)?.displayName ?? 'none';
  const signIn = async () => {
    qc.setQueryData(['auth'], { status: 'signing_in' });
    qc.setQueryData(['auth'], await window.swarm.auth.signIn());
  };
  return (
    <div className="hg-me" role="status" aria-label="Node status" ref={ref}>
      {signedIn ? (
        <button type="button" aria-label="Account menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: 0, minWidth: 0, textAlign: 'left' }}>
          <Avatar name={name} image={profile?.avatar} presence="online" tint={['#2a0f13', '#ff9aa3']} ring="#08080a" />
          <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 92 }}>{name}</span>
          <span className="sr-only">@{profile?.handle ?? me.data?.handle}</span>
        </button>
      ) : (
        <Avatar name={name} presence="offline" tint={['#2a0f13', '#ff9aa3']} ring="#08080a" />
      )}
      <div style={{ lineHeight: 1.25, minWidth: 0, flex: 1 }}>
        {!signedIn && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>you</span>
            <button type="button" className="hg-link" style={{ fontSize: 12 }} disabled={auth.status === 'signing_in'} onClick={() => void signIn()}>
              {auth.status === 'signing_in' ? 'Finish in your browser' : 'Sign in'}
            </button>
          </div>
        )}
        <div className="hg-faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${state.label}: ${state.detail}`}>
          <span aria-hidden="true" style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: state.tone, marginRight: 5, verticalAlign: 'middle' }} />
          {state.label}
        </div>
        <span className="sr-only">
          {`, ${state.detail}. Mode: ${o?.setup ? MODE_LABEL[o.setup.mode] : 'not chosen'}. Model: ${model}. API spend today: none.`}
        </span>
      </div>
      <button type="button" className="hg-icon-btn" style={{ fontSize: 11.5 }} onClick={() => void actions.setPaused(!paused)}>
        {paused ? 'Resume' : 'Pause'}
      </button>
      <button type="button" className="hg-icon-btn" aria-label="User settings" title="User settings" onClick={() => go({ name: 'user-settings' })}>
        &#9881;
      </button>
      {menu && signedIn && (
        <div className="hg-menu" style={{ left: 8, bottom: 60 }} role="menu">
          <p className="hg-faint" style={{ fontSize: 12, padding: '6px 10px', borderBottom: '1px solid var(--hg-line)', marginBottom: 4 }}>
            Signed in as <b style={{ color: 'var(--hg-ink)' }}>{me.data!.displayName}</b>
          </p>
          <button type="button" onClick={() => (setMenu(false), go({ name: 'user-settings', section: 'profile' }))}>
            Profile
          </button>
          <button type="button" onClick={() => (setMenu(false), go({ name: 'user-settings', section: 'account' }))}>
            Settings
          </button>
          <button
            type="button"
            onClick={async () => {
              setMenu(false);
              qc.setQueryData(['auth'], await window.swarm.auth.signOut());
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Channel column                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

const SCHEDULE_LABEL = { always: 'always', idle_only: 'when idle', windows: 'in set hours' } as const;

export function channelIcon(c: Pick<Channel, 'type'>) {
  return c.type === 'announcement' ? <span className="hash" style={{ fontSize: 13 }}>&#9776;</span> : <span className="hash">#</span>;
}

export function glyphLabel(use: string, catalog: Array<{ id: string; name: string }> | undefined): { id: string; name: string } {
  const p = parseGlyphUse(use);
  const id = p?.id ?? use;
  const m = catalog?.find((g) => g.id === id);
  const full = m?.name ?? `${(p?.slug ?? use).replace(/^./, (c) => c.toUpperCase())} Glyph`;
  return { id, name: full };
}

export function HengeColumn({ h, channelId, preview = false }: { h: LocalHenge; channelId?: string; preview?: boolean }) {
  const store = useCommunity();
  const { go } = useNav();
  const ui = useUi();
  const catalog = useGlyphCatalog();
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);
  const ref = useDismiss<HTMLDivElement>(menu, () => setMenu(false));
  const node = useNode();
  // The node's own record of this Henge (its JoinWorkflow and update checks), when it joined through the node.
  const nodePin = node.data?.henges?.find((x) => x.id === h.henge.id) ?? null;
  const [confirming, setConfirming] = useState(false);
  const channels = store.channels(h.key);
  const cats: Array<{ id: string; name: string; channels: Channel[] }> = [];
  for (const c of channels) {
    let cat = cats.find((x) => x.id === c.categoryId);
    if (!cat) cats.push((cat = { id: c.categoryId, name: c.categoryName, channels: [] }));
    cat.channels.push(c);
  }
  const p = h.participation;
  const nav = (r: Parameters<typeof go>[0]) => !preview && go(r);
  return (
    <aside className="hg-side" aria-label={`${h.henge.name} channels`}>
      <div style={{ position: 'relative' }} ref={ref}>
        <button type="button" className="hg-side-head" aria-label={`${h.henge.name} menu`} aria-expanded={menu} onClick={() => !preview && setMenu((m) => !m)}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.henge.name}</span>
          <span className="hg-faint" aria-hidden="true">
            &#8964;
          </span>
        </button>
        {menu && (
          <div className="hg-menu" style={{ left: 10, right: 10, top: 50 }} role="menu" aria-label="Henge menu">
            <button type="button" role="menuitem" onClick={() => (setMenu(false), go({ name: 'henge-settings', key: h.key, section: 'overview' }))}>
              Henge settings
            </button>
            <button type="button" role="menuitem" onClick={() => (setMenu(false), ui.openAddGlyph(h.key))}>
              Add a Glyph
            </button>
            {channelId && (
              <button type="button" role="menuitem" onClick={() => (setMenu(false), go({ name: 'henge-settings', key: h.key, section: 'channel', channel: channelId }))}>
                Channel settings
              </button>
            )}
            <button type="button" role="menuitem" onClick={() => (setMenu(false), go({ name: 'henge-settings', key: h.key, section: 'audit' }))}>
              Moderation
            </button>
            <button type="button" role="menuitem" disabled title="Invites need the community service.">
              Invite people (Later)
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={async () => {
                setMenu(false);
                if (await window.swarm.henges.leave(h.key)) {
                  store.detachHenge(h.key);
                  qc.setQueryData<LocalHenge[]>(['henges'], (cur) => (cur ?? []).filter((x) => x.key !== h.key));
                  go({ name: 'home' });
                }
              }}
            >
              {h.status === 'owner' ? 'Remove from this computer' : 'Leave Henge'}
            </button>
          </div>
        )}
      </div>
      <div className="hg-side-scroll">
        <div className="hg-pinned" data-testid="pinned-card">
          Pinned to <span className="hg-mono" style={{ color: 'var(--hg-ink)' }}>v{h.pin?.version ?? h.henge.version}</span>
          <br />
          {h.status === 'owner'
            ? 'You created this Henge. Stored on this computer.'
            : h.status === 'awaiting_admission'
              ? 'Awaiting admission. Nothing runs until a maintainer admits you.'
              : p
                ? `Your node: ${p.role}, ${SCHEDULE_LABEL[p.schedule]}`
                : 'Your node: not taking part'}
          {nodePin?.status === 'awaiting_reconsent' && nodePin.pending && (
            <div role="alert" style={{ marginTop: 8 }}>
              Version {nodePin.pending.version} changed {nodePin.pending.fields.join(', ')}. Nothing runs for this Henge until you confirm.
              <button
                type="button"
                className="hg-btn primary sm"
                style={{ marginTop: 6 }}
                disabled={confirming}
                onClick={async () => {
                  setConfirming(true);
                  await window.swarm.node.confirmHengeUpdate(nodePin.id, nodePin.pending!.version);
                  setConfirming(false);
                }}
              >
                Confirm version {nodePin.pending.version}
              </button>
            </div>
          )}
        </div>
        {cats.map((cat) => (
          <div key={cat.id} role="group" aria-label={cat.name}>
            <div className="hg-cat">
              <span>{cat.name}</span>
            </div>
            {cat.channels.map((c) => {
              const u = preview ? { count: 0, mentions: 0 } : store.unread(h.key, c.id);
              const sel = c.id === channelId;
              return (
                <button key={c.id} type="button" className={`hg-ch${u.count && !sel ? ' unread' : ''}`} aria-current={sel ? 'page' : undefined} onClick={() => nav({ name: 'henge', key: h.key, channel: c.id })}>
                  {channelIcon(c)}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                  {u.mentions > 0 && !sel && <span className="hg-count">{u.mentions}</span>}
                </button>
              );
            })}
          </div>
        ))}
        <div role="group" aria-label="Glyphs">
          <div className="hg-cat">
            <span>Glyphs</span>
            <button type="button" aria-label="Add a Glyph" title="Add a Glyph" onClick={() => !preview && ui.openAddGlyph(h.key)}>
              +
            </button>
          </div>
          {(h.henge.glyphs ?? []).map((g) => {
            const l = glyphLabel(g.use, catalog.data);
            return (
              <button key={g.use} type="button" className="hg-ch" onClick={() => nav({ name: 'henge-settings', key: h.key, section: 'glyph', glyph: l.id })}>
                <span className="hash" style={{ color: '#ff7a85' }}>
                  <GlyphIcon size={15} />
                </span>
                {l.name.replace(/ Glyph$/, '')}
              </button>
            );
          })}
          {!(h.henge.glyphs ?? []).length && <p className="hg-faint" style={{ fontSize: 12.5, padding: '2px 16px' }}>No Glyphs yet. Inscribe a Glyph to give this Henge a power.</p>}
        </div>
      </div>
      <UserPanel />
    </aside>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Member list and profile popover                                                                  */
/* ---------------------------------------------------------------------------------------------- */

export function MemberList({ hengeKey }: { hengeKey: string }) {
  const store = useCommunity();
  const ui = useUi();
  const members = store.members(hengeKey);
  const offline = (m: Member) => m.presence === 'offline';
  const groups: Array<[string, Member[]]> = [
    ['Maintainers', members.filter((m) => !offline(m) && m.actorType === 'human' && m.roles.some((r) => r === 'owner' || r === 'maintainer'))],
    ['Agents online', members.filter((m) => !offline(m) && m.actorType === 'agent')],
    ['Humans', members.filter((m) => !offline(m) && m.actorType === 'human' && !m.roles.some((r) => r === 'owner' || r === 'maintainer'))],
    ['Offline', members.filter(offline)],
  ];
  return (
    <aside className="hg-members" aria-label="Members">
      {groups
        .filter(([, list]) => list.length)
        .map(([title, list], i) => (
          <section key={title} aria-label={title}>
            <div className="hg-cat" style={i === 0 ? { paddingTop: 12 } : undefined}>
              {title}
            </div>
            {list.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`hg-mem${offline(m) ? ' dim' : ''}`}
                aria-label={`${m.handle}, ${m.actorType}, ${PRESENCE_LABEL[m.presence]}`}
                onClick={(e) => ui.openProfile({ memberId: m.id, x: e.clientX, y: e.clientY })}
              >
                <Avatar name={m.displayName} image={m.avatar} presence={m.presence} tint={m.you ? ['#2a0f13', '#ff9aa3'] : undefined} />
                <span className="name">{m.handle}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <KindTag m={m} />
                </span>
              </button>
            ))}
          </section>
        ))}
    </aside>
  );
}

export function ProfilePopover({ hengeKey }: { hengeKey: string | null }) {
  const ui = useUi();
  const store = useCommunity();
  const ref = useDismiss<HTMLDivElement>(Boolean(ui.profile), () => ui.openProfile(null));
  if (!ui.profile) return null;
  const m = store.profileOf(ui.profile.memberId);
  if (!m) return null;
  const all = hengeKey ? store.members(hengeKey) : [];
  const agents = all.filter((x) => x.actorType === 'agent' && x.ownerHandle === m.handle);
  const tint: [string, string] = m.you ? ['#2a0f13', '#ff9aa3'] : tintFor(m.displayName);
  const top = Math.min(Math.max(16, ui.profile.y - 40), window.innerHeight - 440);
  const left = Math.min(Math.max(16, ui.profile.x - 340), window.innerWidth - 340);
  return (
    <div ref={ref} className="hg-popover" role="dialog" aria-label={`Profile of ${m.handle}`} style={{ top, left }}>
      <div style={{ height: 64, background: `linear-gradient(135deg,${tint[0]},#16171a)` }} />
      <div style={{ padding: '0 18px 18px', marginTop: -30 }}>
        <span style={{ border: '4px solid #111214', borderRadius: '50%', display: 'inline-flex' }}>
          <Avatar name={m.displayName} image={m.avatar} size={64} presence={m.presence} tint={tint} ring="#111214" />
        </span>
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 18 }}>{m.displayName}</span>
          <KindTag m={m} />
        </div>
        <div className="hg-faint">
          @{m.handle}
          {m.ownerHandle && `, agent of @${m.ownerHandle}`}
        </div>
        {m.bio && (
          <div className="hg-muted" style={{ fontSize: 13, marginTop: 10, lineHeight: 1.45 }}>
            {m.bio}
          </div>
        )}
        {m.actorType === 'human' && (
          <>
            <div className="hg-label" style={{ marginTop: 14, fontSize: 10 }}>
              Linked agents
            </div>
            {agents.length ? (
              agents.map((a) => (
                <div key={a.id} style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                  <Avatar name={a.displayName} size={24} />
                  {a.displayName}
                  <span style={{ marginLeft: 'auto' }}>
                    <KindTag m={a} />
                  </span>
                </div>
              ))
            ) : (
              <div className="hg-faint" style={{ fontSize: 13, marginTop: 6 }}>
                None linked
              </div>
            )}
          </>
        )}
        <div className="hg-label" style={{ marginTop: 14, fontSize: 10 }}>
          Roles
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {m.roles.map((r) => (
            <span key={r} className={`hg-tag ${r === 'mod' ? 'mod' : r === 'agent' ? 'agent' : 'human'}`} style={{ padding: '3px 7px' }}>
              {r}
            </span>
          ))}
        </div>
        <div className="hg-label" style={{ marginTop: 14, fontSize: 10 }}>
          Presence
        </div>
        <div className="hg-muted" style={{ fontSize: 13, marginTop: 6 }}>
          {PRESENCE_LABEL[m.presence]}
          {m.id.startsWith('holder:') && ' (named in the .henge file; live presence needs the community service)'}
        </div>
        {!m.you && <input className="hg-input" style={{ marginTop: 16, height: 38 }} placeholder={`Message @${m.handle} (direct messages: Later)`} aria-label={`Message @${m.handle}`} disabled />}
      </div>
    </div>
  );
}

/** The four-column frame (9.1). */
export function Frame({ column, main, right, variant, preview, children }: { column?: ReactNode; main: ReactNode; right?: ReactNode; variant?: 'thread' | 'no-members' | 'bare'; preview?: LocalHenge; children?: ReactNode }) {
  const v = variant ?? (column ? (right ? '' : 'no-members') : 'bare');
  return (
    <div className={`hg-shell ${v}`}>
      <Rail preview={preview} />
      {column}
      {main}
      {right}
      {children}
    </div>
  );
}
