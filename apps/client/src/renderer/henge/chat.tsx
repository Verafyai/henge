import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LocalHenge } from '../../shared/henge';
import { useAuth } from '../api';
import { REPORT_REASONS, type Channel, type Message, type ReportReason } from '../community/store';
import { useNav } from '../router';
import { Avatar, fmtDay, fmtTime, GlyphIcon, KindTag } from './bits';
import { useCommunity, useConnectError, useGlyphCatalog, useUi } from './data';
import { channelIcon, glyphLabel } from './shell';

/* ---------------------------------------------------------------------------------------------- */
/* Markdown subset (8.1): bold, italics, code, https links, quotes, mentions. No HTML is ever parsed. */
/* ---------------------------------------------------------------------------------------------- */

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\(https:\/\/[^)\s]+\))|((?:^|(?<=[^a-z0-9._]))@[a-z0-9._]{2,24})/gi;

function inline(text: string, me: string | null): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<b key={k++}>{t.slice(2, -2)}</b>);
    else if (m[3]) out.push(<i key={k++}>{t.slice(1, -1)}</i>);
    else if (m[4]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(
        <a
          key={k++}
          href={href}
          onClick={(e) => {
            e.preventDefault();
            void window.swarm.openExternal(href!);
          }}
        >
          {label}
        </a>,
      );
    } else if (m[5]) {
      const h = t.slice(1).toLowerCase();
      out.push(
        <span key={k++} className="hg-mention" data-me={h === me || h === 'everyone' || h === 'here' ? 'true' : undefined}>
          {t}
        </span>,
      );
    }
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MessageBody({ text, me }: { text: string; me: string | null }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((l, i) =>
        l.startsWith('> ') ? (
          <blockquote key={i}>{inline(l.slice(2), me)}</blockquote>
        ) : (
          <Fragment key={i}>
            {inline(l, me)}
            {i < lines.length - 1 && <br />}
          </Fragment>
        ),
      )}
    </>
  );
}

const QUICK = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F440}', '\u{2705}', '\u{1F44B}'];

const TOPIC: Record<Channel['type'], string> = {
  text: 'Humans and agents. Be kind, cite sources.',
  announcement: 'Announcements. Only some roles post here; everyone can react and reply in threads.',
  agent_run: 'Agents post task output here. Humans read and reply in threads.',
};

/* ---------------------------------------------------------------------------------------------- */
/* One message                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

function ProposalEmbed({ proposalId, h }: { proposalId: string; h: LocalHenge }) {
  const store = useCommunity();
  const catalog = useGlyphCatalog();
  const p = store.proposal(proposalId);
  const [msg, setMsg] = useState<string | null>(null);
  if (!p) return null;
  const mine = Object.entries(p.votes).find(([id]) => id === store.myProfile()?.id)?.[1];
  const yes = Object.values(p.votes).filter((v) => v === 'yes').length;
  const no = Object.values(p.votes).filter((v) => v === 'no').length;
  const glyph = catalog.data?.find((g) => g.id === p.glyphId);
  const runeName = (id: string) => glyph?.runes?.find((r) => r.id === id)?.name ?? id;
  const entry = (h.henge.glyphs ?? []).find((g) => g.use.startsWith(`${p.glyphId}@`));
  const current = (id: string) => entry?.runes?.[id] ?? glyph?.runes?.find((r) => r.id === id)?.default ?? null;
  const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? 'not set' : String(v));
  const vote = async (c: 'yes' | 'no') => {
    const r = await store.vote(p.id, c);
    setMsg(r.ok ? null : r.message);
  };
  return (
    <div className="hg-embed" data-testid="proposal">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
        <span style={{ color: '#ff7a85' }}>
          <GlyphIcon size={14} />
        </span>
        <span className="hg-mono hg-muted" style={{ fontSize: 11, letterSpacing: '.12em' }}>
          PROPOSAL #{p.number}
        </span>
        <span className="hg-tag pending">{p.status}</span>
      </div>
      <div style={{ fontWeight: 600, marginTop: 8, fontSize: 15 }}>{p.title}</div>
      <div className="hg-muted" style={{ marginTop: 6, lineHeight: 1.5, fontSize: 13.5 }}>
        {p.body}
      </div>
      {glyph && Object.keys(p.changes).length > 0 && (
        <ul style={{ marginTop: 8, fontSize: 13, display: 'grid', gap: 4, paddingLeft: 18 }} aria-label="Proposed changes">
          {Object.entries(p.changes).map(([id, v]) => (
            <li key={id}>
              {runeName(id)}: <span className="hg-mono">{show(current(id))}</span> to <span className="hg-mono">{show(v)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="hg-faint" style={{ fontSize: 12, marginTop: 8 }}>
        Takes effect only if it passes. Votes so far: {yes} yes, {no} no. Tallying and closing run in the Governance Glyph on the community service.
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="button" className="hg-btn quiet sm" aria-pressed={mine === 'yes'} onClick={() => void vote('yes')}>
          Vote yes
        </button>
        <button type="button" className="hg-btn quiet sm" aria-pressed={mine === 'no'} onClick={() => void vote('no')}>
          Vote no
        </button>
        {mine && <span className="hg-faint" style={{ fontSize: 12 }}>Your vote: {mine}</span>}
        {msg && <span className="hg-error">{msg}</span>}
      </div>
    </div>
  );
}

function MessageItem({ m, h, inThread = false, onThread, onReply }: { m: Message; h: LocalHenge; inThread?: boolean; onThread: (id: string) => void; onReply: (m: Message) => void }) {
  const store = useCommunity();
  const ui = useUi();
  const me = store.myProfile();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [reporting, setReporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const role = store.myRoles(h.key)[0] ?? 'member';
  const canManage = store.can(h.key, m.channelId, role, 'manage');
  const own = Boolean(me) && m.authorId === me!.id;
  const replies = inThread ? [] : store.thread(m.id);
  const replyTo = m.replyTo ? store.message(m.replyTo) : null;
  const author = store.profileOf(m.authorId);
  const run = async (p: Promise<{ ok: boolean; message?: string }>) => {
    const r = await p;
    setNote(r.ok ? null : (r.message ?? null));
  };
  if (m.deletedAt)
    return (
      <div className="hg-msg" data-testid="message">
        <span style={{ width: 40, flex: 'none' }} />
        <div className="hg-faint" style={{ fontStyle: 'italic', fontSize: 13.5 }}>
          This message was removed.
        </div>
      </div>
    );
  const tint: [string, string] | undefined = m.authorType === 'glyph' ? ['#2a0f13', '#ff7a85'] : own ? ['#2a0f13', '#ff9aa3'] : undefined;
  return (
    <div className="hg-msg" data-testid="message" aria-label={`Message from ${m.authorName}`}>
      <Avatar name={m.authorName} image={author?.avatar} size={40} tint={tint} />
      <div style={{ minWidth: 0, flex: 1 }}>
        {replyTo && (
          <div className="hg-faint" style={{ fontSize: 12, marginBottom: 2 }}>
            Replying to <b>{replyTo.authorName}</b>: {replyTo.deletedAt ? 'a removed message' : replyTo.body.slice(0, 80)}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" className="who" onClick={(e) => author && ui.openProfile({ memberId: author.id, x: e.clientX, y: e.clientY })}>
            {m.authorName}
          </button>
          <KindTag m={{ actorType: m.authorType }} />
          {m.authorOwner && <span className="hg-faint" style={{ fontSize: 12 }}>agent of @{m.authorOwner}</span>}
          <span className="time">{fmtTime.format(new Date(m.createdAt))}</span>
          {m.pinned && <span className="hg-faint" style={{ fontSize: 11 }}>pinned</span>}
        </div>
        {editing ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await run(store.edit(m.id, draft));
              setEditing(false);
            }}
          >
            <input className="hg-input" style={{ marginTop: 6, height: 38 }} aria-label="Edit message" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
          </form>
        ) : (
          <div className="body">
            <MessageBody text={m.body} me={me?.handle ?? null} />
            {m.editedAt && <span className="hg-faint" style={{ fontSize: 11, marginLeft: 6 }}>(edited)</span>}
          </div>
        )}
        {m.proposal && <ProposalEmbed proposalId={m.proposal.proposalId} h={h} />}
        {Object.keys(m.reactions).length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }} aria-label="Reactions">
            {Object.entries(m.reactions).map(([e, who]) => (
              <button key={e} type="button" className="hg-react" aria-pressed={Boolean(me) && who.includes(me!.id)} aria-label={`${e} ${who.length}`} onClick={() => void run(store.react(m.id, e))}>
                {e} <span className="n">{who.length}</span>
              </button>
            ))}
          </div>
        )}
        {replies.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', gap: 8, fontSize: 12.5 }}>
            <button type="button" className="hg-link" style={{ color: 'var(--hg-info)', fontWeight: 600, textDecoration: 'none' }} onClick={() => onThread(m.id)}>
              {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
            </button>
            <span className="hg-faint">Last reply {fmtTime.format(new Date(replies[replies.length - 1]!.createdAt))}</span>
          </div>
        )}
        {reporting && (
          <div role="group" aria-label="Report reason" style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="hg-faint" style={{ fontSize: 12 }}>
              Report for:
            </span>
            {REPORT_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                className="hg-btn ghost sm"
                onClick={async () => {
                  const res = await store.report(m.id, r as ReportReason);
                  setReporting(false);
                  setNote(res.ok ? 'Reported. Moderators will review it.' : res.message);
                }}
              >
                {r.replace('_', ' ')}
              </button>
            ))}
          </div>
        )}
        {note && (
          <div role="status" className="hg-faint" style={{ fontSize: 12, marginTop: 6 }}>
            {note}
          </div>
        )}
      </div>
      <div className="hg-msg-actions" role="toolbar" aria-label="Message actions">
        {QUICK.slice(0, 3).map((e) => (
          <button key={e} type="button" className="hg-icon-btn" aria-label={`React ${e}`} onClick={() => void run(store.react(m.id, e))}>
            {e}
          </button>
        ))}
        {!inThread && (
          <button type="button" className="hg-icon-btn" aria-label="Reply in thread" onClick={() => onThread(m.id)}>
            &#128172;
          </button>
        )}
        <button type="button" className="hg-icon-btn" aria-label="Reply" onClick={() => onReply(m)}>
          &#8617;
        </button>
        {own && (
          <button type="button" className="hg-icon-btn" aria-label="Edit" onClick={() => setEditing(true)}>
            &#9998;
          </button>
        )}
        {canManage && (
          <button type="button" className="hg-icon-btn" aria-label={m.pinned ? 'Unpin' : 'Pin'} onClick={() => void run(store.pin(m.id))}>
            &#128204;
          </button>
        )}
        {!own && m.authorType !== 'glyph' && (
          <button type="button" className="hg-icon-btn" aria-label="Report" onClick={() => setReporting((r) => !r)}>
            &#9873;
          </button>
        )}
        {(own || canManage) && (
          <button type="button" className="hg-icon-btn" aria-label="Delete" onClick={() => void run(store.remove(m.id))}>
            &#128465;
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Composer                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

function Composer({ h, channel, threadRoot, placeholder, replyTo, onClearReply }: { h: LocalHenge; channel: Channel; threadRoot?: string; placeholder: string; replyTo?: Message | null; onClearReply?: () => void }) {
  const store = useCommunity();
  const auth = useAuth();
  const { go } = useNav();
  const catalog = useGlyphCatalog();
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const role = store.myRoles(h.key)[0] ?? 'member';
  const connectError = useConnectError(h.key);
  const canPost = threadRoot ? store.can(h.key, channel.id, role, 'send') || store.can(h.key, channel.id, role, 'threads') : store.can(h.key, channel.id, role, 'send');
  const commands = useMemo(
    () =>
      (h.henge.glyphs ?? []).flatMap((g) => {
        const l = glyphLabel(g.use, catalog.data);
        return (catalog.data?.find((c) => c.id === l.id)?.commands ?? []).map((c) => ({ ...c, glyph: l.name }));
      }),
    [h.henge.glyphs, catalog.data],
  );
  useEffect(() => () => store.setTyping(h.key, channel.id, false), [store, h.key, channel.id]);

  if (auth.status !== 'signed_in')
    return (
      <div className="hg-composer" style={threadRoot ? { margin: '0 14px 14px' } : undefined}>
        <span>Sign in to chat. Community features need an account.</span>
      </div>
    );
  if (!store.myProfile())
    return (
      <div className="hg-composer" style={threadRoot ? { margin: '0 14px 14px' } : undefined}>
        <span>Set up your profile to chat.</span>
        <button type="button" className="hg-btn primary sm" style={{ marginLeft: 'auto' }} onClick={() => go({ name: 'user-settings', section: 'profile' })}>
          Set up profile
        </button>
      </div>
    );
  if (!store.connected(h.key))
    return (
      <div className="hg-composer" role="status" style={threadRoot ? { margin: '0 14px 14px' } : undefined}>
        <span>{connectError ?? 'Connecting to the community service.'}</span>
      </div>
    );
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    if (body.startsWith('/')) {
      setNotice('Glyph commands are not available in this build yet.');
      return;
    }
    const r = await store.send(h.key, channel.id, body, { threadRoot, replyTo: replyTo?.id });
    if (!r.ok) return setNotice(r.message);
    setText('');
    setNotice(null);
    onClearReply?.();
  };
  return (
    <div style={{ position: 'relative' }}>
      {text.startsWith('/') && commands.length > 0 && (
        <div className="hg-menu" style={{ left: 22, right: 22, bottom: 56 }} aria-label="Glyph commands">
          {commands
            .filter((c) => `/${c.name}`.startsWith(text.split(' ')[0]!))
            .map((c) => (
              <button key={`${c.glyph}-${c.name}`} type="button" onClick={() => setText(`/${c.name} `)}>
                <span className="hg-mono">/{c.name}</span> <span className="hg-faint">{c.description}. {c.glyph}</span>
              </button>
            ))}
        </div>
      )}
      {replyTo && (
        <div className="hg-faint" style={{ margin: '0 22px 6px', fontSize: 12, display: 'flex', gap: 8 }}>
          Replying to <b>{replyTo.authorName}</b>
          <button type="button" className="hg-link" onClick={onClearReply}>
            Cancel
          </button>
        </div>
      )}
      <form
        className="hg-composer"
        style={threadRoot ? { margin: '0 14px 14px' } : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <span aria-hidden="true">+</span>
        <input
          aria-label={threadRoot ? 'Reply in thread' : `Message #${channel.name}`}
          placeholder={canPost ? placeholder : channel.type === 'agent_run' ? `Only agents post in #${channel.name}. You can reply in threads.` : `Your role cannot post in #${channel.name}.`}
          disabled={!canPost}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            store.setTyping(h.key, channel.id, e.target.value.length > 0);
          }}
        />
        {!threadRoot && <span aria-hidden="true">&#128578;&nbsp; @&nbsp; /</span>}
      </form>
      {notice && (
        <p role="status" data-testid="composer-notice" className="hg-faint" style={{ margin: threadRoot ? '-8px 14px 10px' : '-14px 22px 12px', fontSize: 12.5 }}>
          {notice}
        </p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Channel and thread views                                                                         */
/* ---------------------------------------------------------------------------------------------- */

export function ThreadPanel({ h, rootId, onClose }: { h: LocalHenge; rootId: string; onClose: () => void }) {
  const store = useCommunity();
  const root = store.message(rootId);
  const channel = root ? store.channels(h.key).find((c) => c.id === root.channelId) : null;
  if (!root || !channel) return null;
  const replies = store.thread(rootId);
  return (
    <aside aria-label="Thread" style={{ background: 'var(--hg-panel)', borderLeft: '1px solid #141518', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="hg-main-head">
        <span style={{ fontSize: 15 }}>Thread</span>
        <span className="hg-faint" style={{ fontWeight: 400, fontSize: 12.5 }}>
          in #{channel.name}
        </span>
        <button type="button" className="hg-icon-btn" style={{ marginLeft: 'auto' }} aria-label="Close thread" onClick={onClose}>
          &#10005;
        </button>
      </div>
      <div className="hg-msgs" style={{ padding: '14px 16px', gap: 14 }}>
        <MessageItem m={root} h={h} inThread onThread={() => undefined} onReply={() => undefined} />
        <div className="hg-faint" style={{ fontSize: 12 }}>
          {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
        </div>
        {replies.map((m) => (
          <MessageItem key={m.id} m={m} h={h} inThread onThread={() => undefined} onReply={() => undefined} />
        ))}
      </div>
      <Composer h={h} channel={channel} threadRoot={rootId} placeholder="Reply in thread" />
    </aside>
  );
}

export function ChannelView({ h, channel, onThread, showMembers, onToggleMembers }: { h: LocalHenge; channel: Channel; onThread: (id: string | null) => void; showMembers: boolean; onToggleMembers: () => void }) {
  const store = useCommunity();
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [showPins, setShowPins] = useState(false);
  const list = store.messages(h.key, channel.id);
  const pins = store.pins(h.key, channel.id);
  const typing = store.typing(h.key, channel.id);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    store.markRead(h.key, channel.id);
  }, [store, h.key, channel.id, list.length]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [list.length, channel.id]);
  return (
    <main className="hg-main" aria-label={`#${channel.name}`}>
      <header className="hg-main-head">
        <span className="hg-faint" style={{ fontSize: 20 }} aria-hidden="true">
          {channel.type === 'announcement' ? '☰' : '#'}
        </span>
        <h1 style={{ fontFamily: 'inherit', fontSize: 15, fontWeight: 600, letterSpacing: 0 }}>{channel.name}</h1>
        <span className="hg-topic">{TOPIC[channel.type]}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}>
          {channel.slowModeS > 0 && (
            <span className="hg-faint" style={{ fontSize: 12, marginRight: 8 }}>
              Slow mode: {channel.slowModeS} s
            </span>
          )}
          <button type="button" className="hg-icon-btn" disabled title="Search: Later" aria-label="Search (Later)">
            &#128269;
          </button>
          <button type="button" className="hg-icon-btn" aria-label="Pinned messages" aria-pressed={showPins} onClick={() => setShowPins((s) => !s)}>
            &#128204;
          </button>
          <button type="button" className="hg-icon-btn" aria-label="Member list" aria-pressed={showMembers} onClick={onToggleMembers}>
            &#128101;
          </button>
        </span>
      </header>
      <div className="hg-msgs" aria-label="Messages" role="log">
        {pins[0] && (
          <div className="hg-notice" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ color: '#ff7a85' }}>&#128204;</span>
            <span>Pinned: {pins[0].body.slice(0, 140)}</span>
            <span className="hg-faint" style={{ marginLeft: 'auto' }}>
              {pins.length > 1 ? `${pins.length} pinned` : `by ${pins[0].authorName}`}
            </span>
          </div>
        )}
        {showPins && (
          <div className="hg-card" style={{ padding: 12 }} aria-label="Pinned messages list">
            {pins.length ? pins.map((p) => <div key={p.id} style={{ fontSize: 13, padding: '4px 0' }}>{p.authorName}: {p.body}</div>) : <span className="hg-faint">No pinned messages in #{channel.name}.</span>}
          </div>
        )}
        {list.length === 0 && (
          <div style={{ marginTop: 'auto' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--hg-raise)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26 }} className="hg-faint">
              {channelIcon(channel)}
            </div>
            <h2 style={{ fontSize: 26, marginTop: 12 }}>Welcome to #{channel.name}</h2>
            <p className="hg-muted" style={{ marginTop: 4 }}>
              This is the start of #{channel.name}.
            </p>
          </div>
        )}
        {list.map((m, i) => {
          const day = fmtDay.format(new Date(m.createdAt));
          const divider = i === 0 || day !== fmtDay.format(new Date(list[i - 1]!.createdAt));
          return (
            <Fragment key={m.id}>
              {divider && <div className="hg-divider">{day === fmtDay.format(new Date()) ? 'Today' : day}</div>}
              <MessageItem m={m} h={h} onThread={(id) => onThread(id)} onReply={setReplyTo} />
            </Fragment>
          );
        })}
        {typing.length > 0 && (
          <div className="hg-faint" style={{ fontSize: 12, marginLeft: 54 }}>
            {typing.join(' and ')} {typing.length === 1 ? 'is' : 'are'} typing...
          </div>
        )}
        <div ref={end} />
      </div>
      <Composer h={h} channel={channel} placeholder={`Message #${channel.name}, or type / for Glyph commands`} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
    </main>
  );
}
