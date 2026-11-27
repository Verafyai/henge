import type { GlyphManifestV1, RuneV1 } from '@swarm-explorer/schema';
import { useEffect, useState } from 'react';
import type { GlyphAddPlan, IssueView, LocalHenge, RunePlanView } from '../../shared/henge';
import { useNav } from '../router';
import { GlyphTile, Issues, Seg, Toggle } from './bits';
import { myRoleIn, useCommunity, useGlyphCatalog, useLocalHenges, useSetHenge, useUi } from './data';
import { parseGlyphUse, useDismiss } from './shell';

/** Plain words for a permission scope (7.3), for "This Glyph will be able to". */
export function scopeLabel(s: string): string {
  if (s.startsWith('post:channel:')) return `Post in #${s.slice('post:channel:'.length)}`;
  if (s.startsWith('network:')) return `Reach ${s.slice('network:'.length)}`;
  const map: Record<string, string> = {
    'read:members': 'See the member list',
    'read:messages': 'Read messages in channels it is granted',
    'read:benchmarks': 'Read benchmark results',
    'read:learnings': 'Read the learnings log',
    'read:strategies': 'Read strategy files',
    'read:henge_file': 'Read the .henge file',
    'post:audit_log': 'Write to the audit log',
    'propose:henge_file': 'Propose changes to the .henge file',
    'tally:votes': 'Count votes on proposals',
    'run:benchmark': 'Run the frozen benchmark',
    'append:learnings': 'Add learnings with provenance',
    'inject:agent_context': 'Add text to agent context',
    'treasury:hold': 'Hold credits in the shared pool',
    'treasury:pay': 'Pay credits from the shared pool',
    'moderate:delete': 'Delete messages',
    'moderate:timeout': 'Time out members',
    'moderate:kick': 'Remove members',
    'moderate:ban': 'Ban members',
    'moderate:pause_member': "Pause a member's node",
  };
  return map[s] ?? s;
}

const CATEGORIES: Array<{ id: string; label: string; kinds?: string[] }> = [
  { id: 'all', label: 'All Glyphs' },
  { id: 'governance', label: 'Governance', kinds: ['governance'] },
  { id: 'treasury', label: 'Treasury', kinds: ['treasury'] },
  { id: 'benchmark', label: 'Benchmarks', kinds: ['benchmark'] },
  { id: 'strategy', label: 'Strategy', kinds: ['strategy'] },
  { id: 'learnings', label: 'Learnings', kinds: ['learnings'] },
  { id: 'community', label: 'Community', kinds: ['moderation', 'community'] },
  { id: 'added', label: 'Added here' },
];

const addedIds = (h: LocalHenge) => new Set((h.henge.glyphs ?? []).map((g) => parseGlyphUse(g.use)?.id).filter(Boolean) as string[]);

/** 7.5 Add a Glyph (mockup 05). Main checks the grant and decides "Add a Glyph" or "Propose adding this Glyph". */
export function AddGlyphModal({ hengeKey }: { hengeKey: string }) {
  const ui = useUi();
  const catalog = useGlyphCatalog();
  const henges = useLocalHenges();
  const setHenge = useSetHenge();
  const store = useCommunity();
  const { go } = useNav();
  const h = henges.data?.find((x) => x.key === hengeKey);
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  const added = h ? addedIds(h) : new Set<string>();
  const list = (catalog.data ?? []).filter((g) => {
    const c = CATEGORIES.find((x) => x.id === cat)!;
    if (cat === 'added' && !added.has(g.id)) return false;
    if (c.kinds && !c.kinds.includes(g.kind)) return false;
    const t = q.trim().toLowerCase();
    return !t || `${g.name} ${g.summary} ${g.kind}`.toLowerCase().includes(t);
  });
  const [selId, setSelId] = useState<string | null>(null);
  const sel = (catalog.data ?? []).find((g) => g.id === selId) ?? list.find((g) => !added.has(g.id)) ?? list[0] ?? null;
  const [grant, setGrant] = useState<{ id: string | null; scopes: string[] }>({ id: null, scopes: [] });
  // The grant starts as the manifest's requests whenever another Glyph is selected.
  const granted = grant.id === (sel?.id ?? null) ? grant.scopes : sel ? [...sel.permissions.requests] : [];
  const setGranted = (scopes: string[]) => setGrant({ id: sel?.id ?? null, scopes });
  const [extra, setExtra] = useState('');
  const [planState, setPlan] = useState<{ key: string; plan: GlyphAddPlan } | null>(null);
  const [resultState, setResultState] = useState<{ id: string | null; issues: IssueView[] }>({ id: null, issues: [] });
  const result = resultState.id === (sel?.id ?? null) ? resultState.issues : [];
  const setResult = (issues: IssueView[]) => setResultState({ id: sel?.id ?? null, issues });
  const [busy, setBusy] = useState(false);
  const ref = useDismiss<HTMLDivElement>(true, () => ui.openAddGlyph(null));
  const selId2 = sel?.id ?? null;
  const hKey = h?.key ?? null;
  const hVersion = h?.henge.version ?? null;
  const grantedKey = granted.join(',');
  useEffect(() => {
    if (!selId2 || !hKey) return;
    let live = true;
    const scopes = grantedKey ? grantedKey.split(',') : [];
    void window.swarm.henges.planGlyphAdd({ key: hKey, glyphId: selId2, granted: scopes }).then((p) => live && setPlan({ key: `${selId2}|${hVersion}|${grantedKey}`, plan: p }));
    return () => {
      live = false;
    };
  }, [selId2, hKey, hVersion, grantedKey]);
  if (!h) return null;
  const plan = planState && planState.key === `${selId2}|${hVersion}|${grantedKey}` ? planState.plan : null;
  const isAdded = sel ? added.has(sel.id) : false;
  const submit = async () => {
    if (!sel || !plan) return;
    setBusy(true);
    const r = await window.swarm.henges.addGlyph({ key: h.key, glyphId: sel.id, granted });
    setBusy(false);
    if (!r.ok) return setResult(r.issues);
    if (r.mode === 'added') {
      setHenge(r.henge);
      store.attachHenge({ hengeId: r.henge.key, henge: r.henge.henge, myRole: myRoleIn(r.henge) });
      ui.openAddGlyph(null);
      go({ name: 'henge-settings', key: h.key, section: 'glyph', glyph: sel.id });
      return;
    }
    const p = await store.openProposal({
      hengeId: h.key,
      channelId: 'proposals',
      glyphId: 'verafy/governance',
      title: `Add the ${sel.name}`,
      body: `Grants: ${granted.map(scopeLabel).join('; ')}. Adding a Glyph needs a member vote under this Henge's rules.`,
      changes: {},
    });
    if (!p.ok) return setResult([{ code: 'proposal', path: '', message: p.message }]);
    ui.openAddGlyph(null);
    const ch = store.messages(h.key, 'proposals').length ? 'proposals' : store.channels(h.key).find((c) => c.glyphPosts.includes('governance'))?.id;
    go({ name: 'henge', key: h.key, channel: ch });
  };
  const outside = granted.filter((s) => !sel?.permissions.requests.includes(s));
  return (
    <div className="hg-overlay">
      <div ref={ref} className="hg-modal" role="dialog" aria-label="Add a Glyph" style={{ width: 1080, height: 680, display: 'grid', gridTemplateColumns: '200px 1fr 330px', overflow: 'hidden', position: 'relative' }}>
        <div style={{ background: 'var(--hg-side)', padding: '22px 12px', borderRight: '1px solid var(--hg-line)' }}>
          <h3 style={{ fontSize: 18, padding: '0 8px' }}>Add a Glyph</h3>
          <div className="hg-faint" style={{ fontSize: 12, padding: '4px 8px 14px' }}>
            Glyphs add powers to your Henge.
          </div>
          <nav aria-label="Glyph categories">
            {CATEGORIES.map((c) => (
              <button key={c.id} type="button" className="hg-ch" style={{ margin: '1px 0', width: '100%' }} aria-current={cat === c.id ? 'page' : undefined} onClick={() => setCat(c.id)}>
                {c.label}
              </button>
            ))}
          </nav>
        </div>
        <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0, overflowY: 'auto' }}>
          <div className="hg-input">
            <span className="hg-faint" aria-hidden="true">
              &#128269;
            </span>
            <input aria-label="Search Glyphs" placeholder="Search Glyphs" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="hg-label">From Verafy</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} role="listbox" aria-label="Glyphs">
            {list.map((g) => {
              const s = g.id === sel?.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  role="option"
                  aria-selected={s}
                  onClick={() => setSelId(g.id)}
                  style={{ border: `1px solid ${s ? 'rgba(255,42,61,.55)' : 'var(--hg-line)'}`, background: s ? 'rgba(255,42,61,.06)' : 'var(--hg-panel)', borderRadius: 10, padding: 14, display: 'flex', gap: 12, textAlign: 'left', color: 'inherit', cursor: 'pointer' }}
                >
                  <GlyphTile />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontWeight: 600 }}>{g.name}</span>
                      {added.has(g.id) && <span className="hg-tag human">added</span>}
                    </span>
                    <span className="hg-faint" style={{ fontSize: 12, display: 'block' }}>
                      {g.publisher.name.toLowerCase()}
                    </span>
                    <span className="hg-muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.45, display: 'block' }}>
                      {g.summary}
                    </span>
                  </span>
                </button>
              );
            })}
            {list.length === 0 && <p className="hg-faint">No Glyphs match.</p>}
          </div>
          <div className="hg-faint" style={{ fontSize: 12.5, marginTop: 'auto' }}>
            Add by URL (any glyph.yaml link) and the henge.verafy.ai/glyphs directory: Later. These are the built-in example Glyphs.
          </div>
        </div>
        <div style={{ background: 'var(--hg-panel)', borderLeft: '1px solid var(--hg-line)', padding: 22, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          {sel && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <GlyphTile size={48} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{sel.name}</div>
                  <div className="hg-faint" style={{ fontSize: 12 }}>
                    {sel.id.replace('/', ' / ')}, v{sel.version}
                  </div>
                </div>
              </div>
              <div className="hg-label" style={{ marginTop: 20 }}>
                This Glyph will be able to
              </div>
              <div role="group" aria-label="Permissions to grant" style={{ display: 'grid', gap: 9, marginTop: 10, fontSize: 13.5 }}>
                {[...sel.permissions.requests, ...outside].map((s) => (
                  <label key={s} style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }} title={s}>
                    <input type="checkbox" className="sr-only" checked={granted.includes(s)} onChange={(e) => setGranted(e.target.checked ? [...granted, s] : granted.filter((x) => x !== s))} aria-label={scopeLabel(s)} />
                    <span aria-hidden="true" style={{ color: granted.includes(s) ? (sel.permissions.requests.includes(s) ? 'var(--hg-ok)' : 'var(--hg-pending)') : 'var(--hg-faint)', width: 14 }}>
                      {granted.includes(s) ? '✓' : '-'}
                    </span>
                    <span style={{ color: granted.includes(s) ? undefined : 'var(--hg-faint)' }}>{scopeLabel(s)}</span>
                  </label>
                ))}
              </div>
              <form
                style={{ display: 'flex', gap: 6, marginTop: 10 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const s = extra.trim();
                  if (s && !granted.includes(s)) setGranted([...granted, s]);
                  setExtra('');
                }}
              >
                <input className="hg-input" style={{ height: 32, fontSize: 12.5 }} aria-label="Grant another scope" placeholder="Grant another scope, e.g. read:messages" value={extra} onChange={(e) => setExtra(e.target.value)} />
                <button type="submit" className="hg-btn ghost sm">
                  Grant
                </button>
              </form>
              <div className="hg-label" style={{ marginTop: 18 }}>
                It cannot
              </div>
              <div style={{ display: 'grid', gap: 9, marginTop: 10, fontSize: 13.5 }} className="hg-muted">
                {(sel.permissions.never ?? []).map((n) => (
                  <div key={n} style={{ display: 'flex', gap: 10 }}>
                    <span style={{ color: 'var(--hg-accent)' }}>&#215;</span>
                    {n}
                  </div>
                ))}
                {!(sel.permissions.never ?? []).length && <span className="hg-faint">The manifest lists nothing here.</span>}
              </div>
              <div style={{ marginTop: 'auto', paddingTop: 16 }}>
                {plan && !isAdded && (
                  <div className="hg-faint" style={{ fontSize: 12 }}>
                    {plan.reason}
                  </div>
                )}
                <Issues issues={[...(plan?.issues ?? []).filter((i) => i.code !== 'glyph_already_added'), ...result]} />
                <button type="button" className="hg-btn primary" style={{ marginTop: 12, width: '100%' }} disabled={busy || isAdded || !plan || plan.mode === 'none' || (plan.issues.length > 0 && !isAdded)} onClick={() => void submit()}>
                  {isAdded ? 'Added to this Henge' : plan?.mode === 'propose' ? 'Propose adding this Glyph' : 'Add a Glyph'}
                </button>
              </div>
            </>
          )}
        </div>
        <button type="button" className="hg-close" style={{ top: 14, right: 14, width: 30, height: 30 }} aria-label="Close" onClick={() => ui.openAddGlyph(null)}>
          &#10005;
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Glyph settings with Runes (7.6, mockup 06)                                                      */
/* ---------------------------------------------------------------------------------------------- */

const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function RuneControl({ rune, value, roles, channels, onChange }: { rune: RuneV1; value: unknown; roles: string[]; channels: string[]; onChange: (v: unknown) => void }) {
  switch (rune.type) {
    case 'enum':
      return <Seg label={rune.name} value={String(value ?? '')} onChange={(v) => onChange(v)} options={(rune.options ?? []).map((o) => ({ value: String(o), label: String(o).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) }))} />;
    case 'percent': {
      const min = rune.min ?? 0;
      const max = rune.max ?? 1;
      const v = typeof value === 'number' ? value : min;
      return (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span className="hg-muted">{fmtPct(min)}</span>
            <span className="hg-mono">{value === null || value === undefined ? 'not set' : fmtPct(v)}</span>
            <span className="hg-muted">{fmtPct(max)}</span>
          </div>
          <input type="range" aria-label={rune.name} min={min * 100} max={max * 100} step={1} value={Math.round(v * 100)} onChange={(e) => onChange(Number(e.target.value) / 100)} />
        </div>
      );
    }
    case 'boolean':
      return <Toggle label={rune.name} checked={value === true} onChange={onChange} />;
    case 'integer':
    case 'number':
    case 'duration':
      return (
        <div className="hg-input" style={{ height: 40 }}>
          <input
            aria-label={rune.name}
            inputMode="decimal"
            value={value === null || value === undefined ? '' : String(value)}
            placeholder="not set"
            onChange={(e) => {
              const t = e.target.value.trim();
              onChange(t === '' ? null : rune.type === 'integer' ? Math.round(Number(t)) : Number(t));
            }}
          />
          {rune.unit && <span className="hg-faint">{rune.unit}</span>}
        </div>
      );
    case 'roles': {
      const cur = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="group" aria-label={rune.name}>
          {roles.map((r) => (
            <button key={r} type="button" aria-pressed={cur.includes(r)} className={`hg-tag ${cur.includes(r) ? 'human' : 'plain'}`} style={{ padding: '4px 8px', border: cur.includes(r) ? 0 : '1px dashed var(--hg-line2)', cursor: 'pointer' }} onClick={() => onChange(cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r])}>
              {cur.includes(r) ? r : `+ ${r}`}
            </button>
          ))}
        </div>
      );
    }
    case 'channel':
      return (
        <div className="hg-input" style={{ height: 40 }}>
          <select aria-label={rune.name} value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">not set</option>
            {channels.map((c) => (
              <option key={c} value={c}>
                #{c}
              </option>
            ))}
          </select>
        </div>
      );
    default:
      return (
        <div className="hg-input" style={{ height: 40 }}>
          <input
            aria-label={rune.name}
            value={Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value)}
            placeholder="not set"
            onChange={(e) => {
              const t = e.target.value;
              onChange(rune.type === 'list' ? (t.trim() ? t.split(',').map((x) => x.trim()).filter(Boolean) : null) : t || null);
            }}
          />
        </div>
      );
  }
}

export function GlyphSettings({ h, glyph }: { h: LocalHenge; glyph: GlyphManifestV1 }) {
  const store = useCommunity();
  const setHenge = useSetHenge();
  const { go } = useNav();
  const entry = (h.henge.glyphs ?? []).find((g) => parseGlyphUse(g.use)?.id === glyph.id);
  const [tab, setTab] = useState<'runes' | 'channels' | 'commands'>('runes');
  const [panel, setPanel] = useState<'permissions' | 'activity' | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [planState, setPlan] = useState<{ key: string; plan: RunePlanView } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [issues, setIssues] = useState<IssueView[]>([]);
  const roles = Object.keys(h.henge.governance.roles);
  const channels = store.channels(h.key).map((c) => c.id);
  const cosmeticExempt = (h.henge.governance.rule_updates.no_vote_needed_for ?? []).includes('glyphs.runes.cosmetic');
  const current = (r: RuneV1) => (entry?.runes && r.id in entry.runes ? entry.runes[r.id] : (r.default ?? null));
  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    if (draftKey === '{}') return;
    let live = true;
    void window.swarm.henges.planRunes({ key: h.key, glyphId: glyph.id, changes: JSON.parse(draftKey) as Record<string, unknown> }).then((p) => live && p && setPlan({ key: draftKey, plan: p }));
    return () => {
      live = false;
    };
  }, [draftKey, h.key, glyph.id]);
  const plan = planState && planState.key === draftKey ? planState.plan : null;
  const audit = store.auditLog(h.key).filter((a) => a.actorId === `glyph:${glyph.id}`);
  if (!entry)
    return (
      <div>
        <h2 style={{ fontSize: 26 }}>{glyph.name}</h2>
        <p className="hg-muted" style={{ marginTop: 6 }}>
          This Glyph is not added to this Henge.
        </p>
      </div>
    );
  const proposalCount = plan ? Object.keys(plan.proposal).length : 0;
  const directCount = plan ? Object.keys(plan.direct).length : 0;
  const submit = async () => {
    setIssues([]);
    const r = await window.swarm.henges.applyRunes({ key: h.key, glyphId: glyph.id, changes: draft });
    if (!r.ok) return setIssues(r.issues);
    setHenge(r.henge);
    store.attachHenge({ hengeId: r.henge.key, henge: r.henge.henge, myRole: myRoleIn(r.henge) });
    let msg = r.applied.length ? `${r.applied.length} Rune ${r.applied.length === 1 ? 'change' : 'changes'} saved to the .henge file. ` : '';
    if (Object.keys(r.proposal).length) {
      const names = Object.keys(r.proposal).map((id) => glyph.runes?.find((x) => x.id === id)?.name ?? id);
      const p = await store.openProposal({ hengeId: h.key, channelId: 'proposals', glyphId: glyph.id, title: `Change ${names.join(', ')} in the ${glyph.name}`, body: 'Rune changes that need a member vote. Nothing changes until the proposal passes.', changes: r.proposal });
      msg += p.ok ? `Proposal #${p.value.number} opened in #proposals. It takes effect only if it passes.` : p.message;
    }
    setDraft({});
    setStatus(msg.trim());
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: '100%' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <GlyphTile size={52} />
        <div>
          <h2 style={{ fontSize: 26 }}>{glyph.name}</h2>
          <div className="hg-faint" style={{ fontSize: 12.5 }}>
            {glyph.id.replace('/', ' / ')}, v{glyph.version}. Added by {entry.added_by}.
          </div>
        </div>
        <div style={{ marginLeft: 'auto', marginRight: 56, display: 'flex', gap: 10 }}>
          <button type="button" className="hg-btn ghost" aria-pressed={panel === 'permissions'} onClick={() => setPanel(panel === 'permissions' ? null : 'permissions')}>
            Permissions
          </button>
          <button type="button" className="hg-btn ghost" aria-pressed={panel === 'activity'} onClick={() => setPanel(panel === 'activity' ? null : 'activity')}>
            Activity
          </button>
        </div>
      </div>
      {panel === 'permissions' && (
        <div className="hg-card" style={{ padding: 14, fontSize: 13 }} aria-label="Granted permissions">
          <div className="hg-label">Granted</div>
          <ul style={{ marginTop: 8, display: 'grid', gap: 4, paddingLeft: 18 }}>
            {entry.granted.map((s) => (
              <li key={s}>
                {scopeLabel(s)} <span className="hg-faint hg-mono">{s}</span>
              </li>
            ))}
          </ul>
          <p className="hg-faint" style={{ marginTop: 8 }}>
            Widening what a Glyph may do{h.henge.governance.rule_updates.vote_required_for.includes('glyphs.permissions') ? ' needs a member vote.' : " follows this Henge's rules."}
          </p>
        </div>
      )}
      {panel === 'activity' && (
        <div className="hg-card" style={{ padding: 14, fontSize: 13 }} aria-label="Glyph activity">
          {audit.length ? audit.map((a) => <div key={a.id}>{a.action}: {a.target}. {a.reason}</div>) : <span className="hg-faint">No actions by this Glyph on this computer yet.</span>}
        </div>
      )}
      <div className="hg-tabs" role="tablist" style={{ marginTop: 6 }}>
        {(['runes', 'channels', 'commands'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'runes' &&
        (glyph.runes ?? []).map((r) => {
          const v = r.id in draft ? draft[r.id] : current(r);
          const gated = (r.change_requires ?? 'vote') === 'vote' && !(r.cosmetic && cosmeticExempt);
          return (
            <div key={r.id} className="hg-rune" role="group" aria-label={`Rune ${r.name}`}>
              <div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="hg-mono" style={{ fontSize: 10, letterSpacing: '.14em', color: '#ff7a85' }}>
                    RUNE
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{r.name}</span>
                  {r.id in draft && <span className="hg-tag pending">edited</span>}
                </div>
                <div className="hg-muted" style={{ fontSize: 13, marginTop: 5, lineHeight: 1.45 }}>
                  {r.description ?? <span className="hg-mono">{r.id}</span>}
                </div>
                {gated ? (
                  <div className="hg-faint" style={{ fontSize: 11.5, marginTop: 6 }}>
                    Changing this Rune needs a member vote.
                  </div>
                ) : (
                  <div className="hg-faint" style={{ fontSize: 11.5, marginTop: 6 }}>
                    A {r.change_requires === 'owner' ? 'owner' : 'maintainer'} can change this Rune directly.
                  </div>
                )}
              </div>
              <RuneControl
                rune={r}
                value={v}
                roles={roles}
                channels={channels}
                onChange={(nv) => {
                  const next = { ...draft };
                  if (same(nv, current(r))) delete next[r.id];
                  else next[r.id] = nv;
                  setDraft(next);
                  setStatus(null);
                }}
              />
            </div>
          );
        })}
      {tab === 'runes' && !(glyph.runes ?? []).length && <p className="hg-faint">This Glyph has no Runes.</p>}
      {tab === 'channels' && (
        <div className="hg-card" style={{ padding: 14 }}>
          {(glyph.channels ?? []).length ? (glyph.channels ?? []).map((c) => <div key={c.id}>#{c.id} <span className="hg-faint">({c.type})</span></div>) : <span className="hg-faint">This Glyph creates no channels.</span>}
        </div>
      )}
      {tab === 'commands' && (
        <div className="hg-card" style={{ padding: 14, display: 'grid', gap: 6 }}>
          {(glyph.commands ?? []).length ? (
            (glyph.commands ?? []).map((c) => (
              <div key={c.name}>
                <span className="hg-mono">/{c.name}</span> <span className="hg-muted">{c.description}</span> {c.roles && <span className="hg-faint">({c.roles.join(', ')})</span>}
              </div>
            ))
          ) : (
            <span className="hg-faint">This Glyph has no commands.</span>
          )}
        </div>
      )}
      <Issues issues={[...(plan?.issues ?? []), ...issues]} />
      {status && (
        <p role="status" data-testid="rune-status" className="hg-notice">
          {status}{' '}
          {status.includes('#proposals') && (
            <button type="button" className="hg-link" onClick={() => go({ name: 'henge', key: h.key, channel: 'proposals' })}>
              Open #proposals
            </button>
          )}
        </p>
      )}
      {Object.keys(draft).length > 0 && (
        <div className="hg-bar" style={{ marginTop: 'auto' }}>
          <span className="hg-muted" data-testid="rune-bar">
            {proposalCount > 0 && `${proposalCount} Rune ${proposalCount === 1 ? 'change' : 'changes'} will open a proposal in #proposals.`}
            {proposalCount > 0 && directCount > 0 && ' '}
            {directCount > 0 && `${directCount} will apply now.`}
            {!plan && 'Checking the changes.'}
          </span>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="hg-btn ghost" onClick={() => setDraft({})}>
              Reset
            </button>
            <button type="button" className="hg-btn primary" disabled={!plan || plan.issues.length > 0} onClick={() => void submit()}>
              {proposalCount > 0 ? 'Propose changes' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
