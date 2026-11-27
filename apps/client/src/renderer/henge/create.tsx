import { useState } from 'react';
import type { IssueView } from '../../shared/henge';
import { useMe } from '../api';
import { useNav } from '../router';
import { BrandCorner, Field, GlyphTile, initialsOf, Issues } from './bits';
import { myRoleIn, useCommunity, useGlyphCatalog, useSetHenge } from './data';

const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** 9.2 Create a Henge (no mockup): template, name, icon, first channels, default Glyphs, storage. */
export function CreateHengePage() {
  const store = useCommunity();
  const me = useMe();
  const catalog = useGlyphCatalog();
  const setHenge = useSetHenge();
  const { go, back, canBack } = useNav();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [tagline, setTagline] = useState('');
  const [channels, setChannels] = useState<string[]>(['general', 'introductions']);
  const [newChannel, setNewChannel] = useState('');
  const [glyphs, setGlyphs] = useState<string[]>(['verafy/governance', 'verafy/moderation']);
  const [issues, setIssues] = useState<IssueView[]>([]);
  const [busy, setBusy] = useState(false);
  const owner = store.myProfile()?.handle ?? me.data?.handle ?? 'you';
  const addChannel = () => {
    const c = newChannel.trim().toLowerCase().replace(/\s+/g, '-');
    if (!CHANNEL_RE.test(c) || channels.includes(c)) return;
    setChannels([...channels, c]);
    setNewChannel('');
  };
  const create = async () => {
    setBusy(true);
    const r = await window.swarm.henges.create({ template: 'forecasting', name: name.trim(), icon: (icon.trim() || initialsOf(name)).slice(0, 2), tagline: tagline.trim(), channels, glyphs, storage: 'local', ownerHandle: owner.replace(/[^a-z0-9._-]/g, '') || 'you' });
    setBusy(false);
    if (!r.ok) return setIssues(r.issues);
    setHenge(r.henge);
    store.attachHenge({ hengeId: r.henge.key, henge: r.henge.henge, myRole: myRoleIn(r.henge) });
    go({ name: 'henge', key: r.henge.key });
  };
  return (
    <div className="hg-stage" style={{ alignItems: 'flex-start' }}>
      <BrandCorner />
      <form
        className="hg-modal"
        style={{ width: 760, padding: 34 }}
        aria-labelledby="create-title"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h2 id="create-title" style={{ fontSize: 28 }}>
          Create a Henge
        </h2>
        <p className="hg-muted" style={{ marginTop: 6 }}>
          A Henge is a swarm with its own channels, rules and Glyphs. It is described by one <span className="hg-mono">.henge</span> file.
        </p>
        <div className="hg-label" style={{ marginTop: 24 }}>
          Template
        </div>
        <div role="radiogroup" aria-label="Template" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 10 }}>
          <button type="button" role="radio" aria-checked="true" className="hg-card" style={{ padding: 14, textAlign: 'left', borderColor: 'rgba(255,42,61,.55)', background: 'rgba(255,42,61,.06)', color: 'inherit', cursor: 'pointer' }}>
            <div style={{ fontWeight: 600 }}>Forecasting swarm</div>
            <div className="hg-muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.45 }}>
              From the example .henge file: a frozen benchmark, strategies and learnings. Edit the file before you invite anyone.
            </div>
          </button>
          <button type="button" role="radio" aria-checked="false" disabled className="hg-card" style={{ padding: 14, textAlign: 'left', color: 'inherit', opacity: 0.55, cursor: 'not-allowed' }}>
            <div style={{ fontWeight: 600 }}>
              Community only <span className="hg-tag plain">Later</span>
            </div>
            <div className="hg-muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.45 }}>
              Chat without a task. The v1 file format needs a task and a benchmark.
            </div>
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 16, marginTop: 22 }}>
          <Field label="Name" htmlFor="c-name">
            <input id="c-name" className="hg-input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Icon" htmlFor="c-icon" hint="1 or 2 letters">
            <input id="c-icon" className="hg-input" maxLength={2} placeholder={name ? initialsOf(name) : 'AB'} value={icon} onChange={(e) => setIcon(e.target.value.toUpperCase())} />
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Field label="Tagline" htmlFor="c-tag">
            <input id="c-tag" className="hg-input" maxLength={140} value={tagline} onChange={(e) => setTagline(e.target.value)} />
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Field label="First channels" htmlFor="c-channel">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }} aria-label="First channels">
              {channels.map((c) => (
                <span key={c} className="hg-tag plain" style={{ padding: '4px 8px', fontSize: 11, display: 'inline-flex', gap: 6 }}>
                  #{c}
                  <button type="button" aria-label={`Remove #${c}`} onClick={() => setChannels(channels.filter((x) => x !== c))} style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer' }}>
                    &#215;
                  </button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="c-channel"
                className="hg-input"
                placeholder="channel-name"
                value={newChannel}
                onChange={(e) => setNewChannel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addChannel();
                  }
                }}
              />
              <button type="button" className="hg-btn ghost" onClick={addChannel}>
                Add channel
              </button>
            </div>
          </Field>
        </div>
        <div className="hg-label" style={{ marginTop: 22 }}>
          Glyphs
        </div>
        <div role="group" aria-label="Default Glyphs" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          {(catalog.data ?? []).map((g) => (
            <label key={g.id} className="hg-card" style={{ padding: 12, display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" className="hg-check" checked={glyphs.includes(g.id)} onChange={(e) => setGlyphs(e.target.checked ? [...glyphs, g.id] : glyphs.filter((x) => x !== g.id))} aria-label={g.name} />
              <GlyphTile size={30} />
              <span>
                <span style={{ fontWeight: 600, display: 'block' }}>{g.name}</span>
                <span className="hg-faint" style={{ fontSize: 12 }}>
                  {g.summary}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="hg-label" style={{ marginTop: 22 }}>
          Where to store the .henge file
        </div>
        <div role="radiogroup" aria-label="Storage" style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          <label className="hg-input" style={{ cursor: 'pointer' }}>
            <input type="radio" name="storage" defaultChecked style={{ flex: 'none' }} />
            On this computer
            <span className="hg-faint" style={{ marginLeft: 'auto', fontSize: 12 }}>
              you are the owner
            </span>
          </label>
          <label className="hg-input" style={{ opacity: 0.55 }}>
            <input type="radio" name="storage" disabled style={{ flex: 'none' }} />
            GitHub repository
            <span className="hg-tag plain" style={{ marginLeft: 'auto' }}>
              Later
            </span>
          </label>
        </div>
        <p className="hg-faint" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
          The file keeps the template&apos;s example.org links until you publish it. Owner: @{owner}.
        </p>
        {issues.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Issues issues={issues} />
          </div>
        )}
        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
          <button type="button" className="hg-btn ghost" onClick={() => (canBack ? back() : go({ name: 'home' }))}>
            Cancel
          </button>
          <button type="submit" className="hg-btn primary" disabled={busy || !name.trim() || channels.length === 0}>
            Create Henge
          </button>
        </div>
      </form>
    </div>
  );
}
