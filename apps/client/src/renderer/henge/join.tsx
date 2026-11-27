import { useEffect, useRef, useState } from 'react';
import type { HengeResolveView, IssueView, LocalHenge, Participation } from '../../shared/henge';
import { useNode } from '../api';
import { useNav } from '../router';
import { BrandCorner, Field, Issues, Seg, Toggle } from './bits';
import { myRoleIn, useCommunity, useGlyphCatalog, useLocalHenges, useSetHenge } from './data';
import { Frame, glyphLabel, HengeColumn, MemberList } from './shell';

type Resolved = Extract<HengeResolveView, { ok: true }>;

/** 9.2 Join by link or invite: paste, the invite card (mockup 03), then participation (mockup 04). Nothing joins until "Join". */
export function AddHengePage({ initialUrl }: { initialUrl?: string }) {
  const [link, setLink] = useState(initialUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; issues: IssueView[] } | null>(null);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [step, setStep] = useState<'card' | 'participation'>('card');
  const open = async (value: string) => {
    setBusy(true);
    setError(null);
    const r = await window.swarm.henges.resolve(value);
    setBusy(false);
    if (r.ok) {
      setResolved(r);
      setStep('card');
    } else setError({ message: r.message, issues: r.issues.length > 1 ? r.issues : [] });
  };
  const started = useRef(false);
  useEffect(() => {
    if (!initialUrl || started.current) return;
    started.current = true;
    // Resolve the deep-linked URL once; the page is keyed by URL.
    queueMicrotask(() => void open(initialUrl));
  }, [initialUrl]);

  if (resolved && step === 'participation') return <ParticipationStep r={resolved} onBack={() => setStep('card')} />;
  if (resolved) return <InviteCard r={resolved} onAccept={() => setStep('participation')} onCancel={() => setResolved(null)} />;
  return (
    <div className="hg-stage">
      <BrandCorner />
      <form
        className="hg-modal"
        style={{ width: 560, padding: 34 }}
        aria-labelledby="join-title"
        onSubmit={(e) => {
          e.preventDefault();
          void open(link);
        }}
      >
        <h2 id="join-title" style={{ fontSize: 28 }}>
          Join a Henge
        </h2>
        <p className="hg-muted" style={{ marginTop: 6, lineHeight: 1.5 }}>
          Paste a <span className="hg-mono" style={{ color: 'var(--hg-ink)' }}>.henge</span> link, an invite link or a <span className="hg-mono">henge://add</span> link. You will see its rules and Glyphs before anything is joined.
        </p>
        <div style={{ marginTop: 20 }}>
          <input className="hg-input" aria-label="Henge link" placeholder="https://github.com/your-org/your-henge/blob/main/your.henge.yaml" value={link} onChange={(e) => setLink(e.target.value)} autoFocus />
        </div>
        {error && (
          <div style={{ marginTop: 12 }} role="alert">
            <p className="hg-error">{error.message}</p>
            {error.issues.length > 0 && <Issues issues={error.issues.slice(0, 6)} />}
          </div>
        )}
        <div style={{ marginTop: 22, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <BackLink />
          <button type="submit" className="hg-btn primary" disabled={busy || !link.trim()}>
            {busy ? 'Checking the link' : 'Open link'}
          </button>
        </div>
      </form>
    </div>
  );
}

function BackLink() {
  const { back, canBack, go } = useNav();
  return (
    <button type="button" className="hg-link" onClick={() => (canBack ? back() : go({ name: 'home' }))}>
      Cancel
    </button>
  );
}

function InviteCard({ r, onAccept, onCancel }: { r: Resolved; onAccept: () => void; onCancel: () => void }) {
  const h = r.henge;
  const catalog = useGlyphCatalog();
  const { go } = useNav();
  const rules = h.admission.requirements.attest ?? [];
  const [checked, setChecked] = useState<boolean[]>(() => rules.map(() => false));
  const all = checked.every(Boolean);
  const icon = typeof h.landing['x-henge-icon-text'] === 'string' ? (h.landing['x-henge-icon-text'] as string) : h.landing.title.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const request = h.admission.mode !== 'open';
  return (
    <div className="hg-stage" style={{ background: 'radial-gradient(800px 500px at 30% 20%,rgba(255,42,61,.12),transparent 60%),radial-gradient(700px 500px at 80% 90%,rgba(143,180,255,.06),transparent 60%),#070708' }}>
      <BrandCorner />
      <section className="hg-modal" aria-labelledby="invite-title" style={{ width: 500, padding: '34px 34px 28px', textAlign: 'center' }}>
        <div aria-hidden="true" style={{ width: 84, height: 84, margin: '0 auto', borderRadius: 24, background: '#2a0f13', color: '#ff9aa3', display: 'flex', alignItems: 'center', justifyContent: 'center', font: "700 30px 'Chakra Petch'", boxShadow: 'inset 0 0 0 1px rgba(255,42,61,.5)' }}>
          {icon}
        </div>
        <div className="hg-muted" style={{ marginTop: 18, fontSize: 14 }}>
          You are about to join
        </div>
        <h2 id="invite-title" style={{ fontSize: 30, marginTop: 6 }}>
          {h.name}
        </h2>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 18, marginTop: 10, fontSize: 13 }} className="hg-muted">
          <span>Version {h.version}</span>
          <span>{request ? 'Admission by request' : `Admission: ${h.admission.mode}`}</span>
          <span title="Live presence and member counts come from the community service.">Members: not connected</span>
        </div>
        <p className="hg-muted" style={{ marginTop: 14, lineHeight: 1.55, fontSize: 14 }}>
          {h.landing.tagline}
        </p>
        {r.existingKey && (
          <p className="hg-notice" style={{ marginTop: 14 }}>
            This Henge is already on this computer.{' '}
            <button type="button" className="hg-link" onClick={() => go({ name: 'henge', key: r.existingKey! })}>
              Open it
            </button>
          </p>
        )}
        <fieldset style={{ textAlign: 'left', marginTop: 20, background: 'var(--hg-panel)', border: '1px solid var(--hg-line)', borderRadius: 10, padding: '16px 18px' }}>
          <legend className="hg-label" style={{ float: 'left', width: '100%' }}>
            Rules from this Henge
          </legend>
          {rules.length === 0 && <p className="hg-faint" style={{ marginTop: 12, fontSize: 13 }}>This Henge lists no rules to accept.</p>}
          {rules.map((rule, i) => (
            <label key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12, cursor: 'pointer', clear: 'both' }}>
              <input type="checkbox" className="hg-check" checked={checked[i]} onChange={(e) => setChecked((c) => c.map((v, j) => (j === i ? e.target.checked : v)))} />
              <span style={{ lineHeight: 1.45 }}>{rule}</span>
            </label>
          ))}
        </fieldset>
        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }} aria-label="Glyphs this Henge has added">
          {(h.glyphs ?? []).map((g) => (
            <span key={g.use} className="hg-tag glyph">
              {glyphLabel(g.use, catalog.data).name.replace(/ Glyph$/, '')}
            </span>
          ))}
        </div>
        {r.unchecked.length > 0 && (
          <p className="hg-faint" style={{ fontSize: 12, marginTop: 10 }}>
            Not checked (unknown Glyph): {r.unchecked.join(', ')}
          </p>
        )}
        <button type="button" className="hg-btn primary lg" style={{ width: '100%', marginTop: 20 }} disabled={!all} onClick={onAccept}>
          Accept invite
        </button>
        <div className="hg-faint" style={{ marginTop: 12, fontSize: 12 }}>
          Next: set how your agent takes part.{request ? ' Nothing runs until a maintainer admits you.' : ''}
        </div>
        <div className="hg-mono hg-faint" data-testid="henge-source" style={{ marginTop: 14, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.url}>
          {r.url.replace(/^https:\/\//, '')}
        </div>
        <button type="button" className="hg-link" style={{ marginTop: 10, fontSize: 12 }} onClick={onCancel}>
          Use a different link
        </button>
      </section>
    </div>
  );
}

const keyOf = (id: string) => id.replace('/', '--');

function ParticipationStep({ r, onBack }: { r: Resolved; onBack: () => void }) {
  const h = r.henge;
  const store = useCommunity();
  const node = useNode();
  const henges = useLocalHenges();
  const setHenge = useSetHenge();
  const { go } = useNav();
  const key = keyOf(h.id);
  const preview: LocalHenge = { key, henge: h, status: h.admission.mode === 'open' ? 'joined' : 'awaiting_admission', sourceUrl: r.url, pin: r.pin, participation: null, file: '', addedAt: 0 };
  useEffect(() => {
    store.attachHenge({ hengeId: key, henge: h, myRole: 'member' });
    return () => {
      if (!henges.data?.some((x) => x.key === key)) store.detachHenge(key);
    };
    // Attach once for the preview; joining keeps it attached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const models = node.data?.models.installed ?? [];
  const machineCores = node.data?.detection?.hardware.cpu.cores ?? null;
  const cores = h.participation.compute.cpu_cores;
  const minC = cores.min ?? 1;
  const maxC = Math.max(minC, Math.min(cores.max ?? machineCores ?? minC, machineCores ?? cores.max ?? minC));
  const roles = h.participation.roles_offered;
  const cap = h.participation.budget.daily_cap;
  const [role, setRole] = useState(roles[0]?.id ?? 'worker');
  const [model, setModel] = useState<string>(node.data?.models.storage.activeModel ?? models[0]?.contentHash ?? '');
  const [capText, setCapText] = useState(cap.default !== null ? String(cap.default) : '');
  const [cpu, setCpu] = useState(Math.min(maxC, Math.max(minC, cores.default ?? minC)));
  const [schedule, setSchedule] = useState<Participation['schedule']>(h.participation.schedule.default);
  const [reconsent, setReconsent] = useState(true);
  const [issues, setIssues] = useState<IssueView[]>([]);
  const [busy, setBusy] = useState(false);
  const capCents = capText.trim() === '' ? null : Math.round(Number(capText) * 100);
  const capBad = capCents !== null && !(Number.isFinite(capCents) && capCents >= 1);
  const capMissing = cap.required && capCents === null;
  const join = async () => {
    setBusy(true);
    const res = await window.swarm.henges.join({
      url: r.url,
      bundleDigest: r.pin.bundle_digest,
      attested: h.admission.requirements.attest ?? [],
      participation: { role, model: model || null, dailyCapCents: capCents, cpuCores: cpu, schedule, reconsent },
    });
    if (!res.ok) {
      setBusy(false);
      return setIssues(res.issues);
    }
    // The node's budget guard and its JoinWorkflow (spin-out 6.4, 9.3). The node resolves https links only.
    const usd = capCents === null ? null : (capCents / 100).toFixed(2);
    if (usd !== null) await window.swarm.node.setDailyCap(usd);
    if (r.url.startsWith('https://')) void window.swarm.node.joinHenge(r.url, usd);
    setBusy(false);
    setHenge(res.henge);
    store.attachHenge({ hengeId: res.henge.key, henge: res.henge.henge, myRole: myRoleIn(res.henge) });
    go({ name: 'henge', key: res.henge.key });
  };
  return (
    <Frame preview={preview} column={<HengeColumn h={preview} preview />} main={<main className="hg-main" />} right={<MemberList hengeKey={key} />}>
      <div className="hg-overlay">
        <form
          className="hg-modal"
          style={{ width: 620, padding: '28px 30px' }}
          aria-labelledby="part-title"
          onSubmit={(e) => {
            e.preventDefault();
            void join();
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="hg-hicon sel" style={{ width: 40, height: 40, fontSize: 13, cursor: 'default' }} aria-hidden="true">
              {h.landing.title.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div className="hg-faint" style={{ fontSize: 12 }}>
                Step 2 of 2
              </div>
              <h2 id="part-title" style={{ fontSize: 22 }}>
                How should your agent take part?
              </h2>
            </div>
          </div>
          <div style={{ display: 'grid', gap: 18, marginTop: 22 }}>
            <Field label="Role">
              <Seg label="Role" options={roles.map((x) => ({ value: x.id, label: x.id.charAt(0).toUpperCase() + x.id.slice(1), title: x.description }))} value={role} onChange={setRole} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Field label="Agent model" htmlFor="part-model">
                <div className="hg-input">
                  <select id="part-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={!h.participation.models.local_models}>
                    {models.length === 0 && <option value="">No local model yet</option>}
                    {models.map((m) => (
                      <option key={m.contentHash} value={m.contentHash}>
                        {m.displayName}
                      </option>
                    ))}
                    <option value="api" disabled>
                      Your API key (Later)
                    </option>
                  </select>
                  <span className="hg-faint" style={{ fontSize: 12 }}>
                    local
                  </span>
                </div>
              </Field>
              <Field label={<>Daily cap{cap.required ? ' (required)' : ''}</>} htmlFor="part-cap" hint={capMissing ? 'This Henge requires a daily cap before you join.' : capBad ? 'Enter an amount of at least $0.01.' : undefined}>
                <div className="hg-input">
                  <span>{h.participation.budget.currency === 'USD' ? '$' : h.participation.budget.currency}</span>
                  <input id="part-cap" aria-label="Daily cap" inputMode="decimal" placeholder="Set a cap" value={capText} onChange={(e) => setCapText(e.target.value.replace(/[^0-9.]/g, ''))} />
                  {h.participation.budget.hard_stop && (
                    <span className="hg-faint" style={{ fontSize: 12 }}>
                      hard stop
                    </span>
                  )}
                </div>
              </Field>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Field label={`CPU cores: ${cpu}${machineCores ? ` of ${machineCores}` : ''}`} htmlFor="part-cpu">
                <input id="part-cpu" type="range" min={minC} max={maxC} value={cpu} onChange={(e) => setCpu(Number(e.target.value))} aria-label="CPU cores" />
              </Field>
              <Field label="When to run">
                <Seg
                  label="When to run"
                  value={schedule}
                  onChange={setSchedule}
                  options={[
                    { value: 'always', label: 'Always' },
                    { value: 'idle_only', label: 'Idle' },
                    { value: 'windows', label: 'Hours', disabled: !h.participation.schedule.windows?.length, title: h.participation.schedule.windows?.length ? undefined : 'This Henge lists no hours. Set your own in run rules.' },
                  ]}
                />
              </Field>
            </div>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <Toggle label="Ask me again if this Henge changes its limits or adds a new Glyph" checked={reconsent} onChange={setReconsent} />
              Ask me again if this Henge changes its limits or adds a new Glyph
            </label>
            <p className="hg-faint" style={{ fontSize: 12, lineHeight: 1.5 }}>
              When to run and CPU cores update this computer&apos;s run rules. Your API keys stay in the OS keychain.
            </p>
          </div>
          {issues.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Issues issues={issues} />
            </div>
          )}
          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="hg-btn ghost" onClick={onBack}>
              Back
            </button>
            <button type="submit" className="hg-btn primary" disabled={busy || capMissing || capBad}>
              Join {h.landing.title}
            </button>
          </div>
        </form>
      </div>
    </Frame>
  );
}
