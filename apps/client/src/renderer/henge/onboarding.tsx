import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth, useMe, useNode } from '../api';
import { Avatar, BrandCorner, Field } from './bits';
import { prefs, useCommunity } from './data';

/** 9.2 Sign in (mockup 07). Only the system-browser sign in exists today; the rest says "Later". */
export function SignInScreen({ onLocal }: { onLocal: () => void }) {
  const auth = useAuth();
  const qc = useQueryClient();
  const signIn = async () => {
    qc.setQueryData(['auth'], { status: 'signing_in' });
    qc.setQueryData(['auth'], await window.swarm.auth.signIn());
  };
  return (
    <div className="hg-stage">
      <BrandCorner />
      <section aria-labelledby="welcome" className="hg-modal" style={{ width: 820, display: 'grid', gridTemplateColumns: '1fr 260px', gap: 34, padding: 34 }}>
        <div>
          <h2 id="welcome" style={{ fontSize: 28 }}>
            Welcome to Henge
          </h2>
          <p className="hg-muted" style={{ marginTop: 6 }}>
            Sign in to join Henges and keep your agent&apos;s memberships in sync.
          </p>
          <div style={{ marginTop: 22, display: 'grid', gap: 12 }}>
            <button type="button" className="hg-btn quiet lg" style={{ justifyContent: 'flex-start' }} disabled={auth.status === 'signing_in'} onClick={() => void signIn()}>
              <GitHubDot /> {auth.status === 'signing_in' ? 'Finish in your browser' : 'Continue with GitHub'}
            </button>
            <button type="button" className="hg-btn quiet lg" style={{ justifyContent: 'flex-start' }} disabled title="Email sign in is not available yet.">
              <span aria-hidden="true">&#9993;</span> Continue with email <span className="hg-tag plain" style={{ marginLeft: 'auto' }}>Later</span>
            </button>
          </div>
          {auth.error && (
            <p role="alert" className="hg-error" style={{ marginTop: 10 }}>
              {auth.error}
            </p>
          )}
          <div className="hg-divider" style={{ margin: '20px 0' }}>
            or
          </div>
          <button type="button" className="hg-btn ghost" style={{ width: '100%' }} onClick={onLocal}>
            Run locally without an account
          </button>
          <p className="hg-faint" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.5 }}>
            Your API keys stay in your OS keychain. Henge never uploads them. Sign in opens your web browser. Without an account, chat and profiles stay off until you sign in.
          </p>
        </div>
        <div style={{ borderLeft: '1px solid var(--hg-line)', paddingLeft: 30, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <div aria-hidden="true" style={{ width: 160, height: 160, borderRadius: 14, border: '1px dashed var(--hg-line2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="hg-faint">
            <span className="hg-mono" style={{ fontSize: 11, letterSpacing: '.14em' }}>
              LATER
            </span>
          </div>
          <div style={{ fontWeight: 600, marginTop: 16 }}>Add by phone</div>
          <div className="hg-muted" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.45 }}>
            Sign in here from the Henge mobile app. Not available yet.
          </div>
        </div>
      </section>
    </div>
  );
}

function GitHubDot() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}

/** Square crop, re-encoded on this computer, so EXIF and other metadata never leave it (8.1 Profiles). */
async function processAvatar(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Use a PNG, JPG or WebP image.');
  if (file.size > 4 * 1024 * 1024) throw new Error('Images can be up to 4 MB.');
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  canvas.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
  return canvas.toDataURL('image/webp', 0.9);
}

export function ProfileEditor({ onDone, onSkip, step = true }: { onDone: () => void; onSkip?: () => void; step?: boolean }) {
  const store = useCommunity();
  const me = useMe();
  const existing = store.myProfile();
  const [displayName, setDisplayName] = useState(existing?.displayName ?? me.data?.displayName ?? '');
  const [handle, setHandle] = useState(existing?.handle ?? me.data?.handle ?? '');
  const [bio, setBio] = useState(existing?.bio ?? '');
  const [avatar, setAvatar] = useState<string | null>(existing?.avatar ?? null);
  const [checked, setAvail] = useState<{ handle: string; ok: boolean; message: string } | null>(null);
  const avail = !handle ? null : handle === existing?.handle ? { ok: true, message: 'Your handle' } : checked?.handle === handle ? checked : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!handle || handle === existing?.handle) return;
    let live = true;
    const t = setTimeout(() => void store.checkHandle(handle).then((r) => live && setAvail({ handle, ...r })), 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [handle, store, existing?.handle]);

  const save = async () => {
    setBusy(true);
    const r = await store.saveProfile({ handle, displayName, bio, avatar });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    onDone();
  };
  const name = displayName || 'You';
  return (
    <section aria-labelledby="profile-title" className="hg-modal" style={{ width: 900, display: 'grid', gridTemplateColumns: '1fr 330px', overflow: 'hidden' }}>
      <form
        style={{ padding: 34 }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {step && <div className="hg-faint" style={{ fontSize: 12 }}>Step 1 of 2</div>}
        <h2 id="profile-title" style={{ fontSize: 28, marginTop: 4 }}>
          Set up your profile
        </h2>
        <p className="hg-muted" style={{ marginTop: 6 }}>
          This is how people and agents see you in every Henge you join.
        </p>
        <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 18 }}>
          <span style={{ borderRadius: '50%', border: '2px dashed rgba(255,42,61,.5)', padding: 0, display: 'inline-flex' }}>
            <Avatar name={name} image={avatar} size={84} tint={['#2a0f13', '#ff9aa3']} />
          </span>
          <div>
            <label className="hg-btn quiet" style={{ cursor: 'pointer' }}>
              Upload avatar
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                aria-label="Upload avatar"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    setAvatar(await processAvatar(f));
                    setError(null);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'That image could not be read.');
                  }
                }}
              />
            </label>
            <div className="hg-faint" style={{ fontSize: 12, marginTop: 6 }}>
              PNG, JPG or WebP. Square, up to 4 MB.
            </div>
          </div>
        </div>
        <div style={{ marginTop: 22 }}>
          <Field label="Display name" htmlFor="p-name">
            <input id="p-name" className="hg-input" maxLength={32} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Field label="Handle" htmlFor="p-handle" hint="Unique across Henge. Lowercase letters, numbers, dot and underscore.">
            <div className="hg-input">
              <span className="hg-faint">@</span>
              <input id="p-handle" aria-label="Handle" maxLength={24} value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} />
              {avail && (
                <span data-testid="handle-availability" style={{ marginLeft: 'auto', fontSize: 12.5, color: avail.ok ? 'var(--hg-ok)' : '#ff9aa3', whiteSpace: 'nowrap' }}>
                  {avail.ok ? `✓ ${avail.message}` : avail.message}
                </span>
              )}
            </div>
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Field label={`Bio (${bio.length} of 190)`} htmlFor="p-bio">
            <textarea id="p-bio" className="hg-input" maxLength={190} value={bio} onChange={(e) => setBio(e.target.value)} />
          </Field>
        </div>
        {error && (
          <p role="alert" className="hg-error" style={{ marginTop: 10 }}>
            {error}
          </p>
        )}
        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {onSkip ? (
            <button type="button" className="hg-link hg-faint" style={{ textDecoration: 'none' }} onClick={onSkip}>
              Skip for now
            </button>
          ) : (
            <span />
          )}
          <button type="submit" className="hg-btn primary" disabled={busy || !avail?.ok || !displayName.trim()}>
            {step ? 'Next: link your agent' : 'Save profile'}
          </button>
        </div>
      </form>
      <div style={{ background: 'var(--hg-panel)', borderLeft: '1px solid var(--hg-line)', padding: '34px 26px' }}>
        <div className="hg-label">Preview</div>
        <ProfileCard name={name} handle={handle || 'handle'} bio={bio} avatar={avatar} agents={existing?.agents.map((a) => a.handle) ?? []} />
      </div>
    </section>
  );
}

function ProfileCard({ name, handle, bio, avatar, agents }: { name: string; handle: string; bio: string; avatar: string | null; agents: string[] }) {
  return (
    <div style={{ marginTop: 14, borderRadius: 14, overflow: 'hidden', border: '1px solid var(--hg-line)', background: '#111214' }}>
      <div style={{ height: 70, background: 'linear-gradient(135deg,#4a1a20,#16171a)' }} />
      <div style={{ padding: '0 18px 18px', marginTop: -30 }}>
        <span style={{ border: '4px solid #111214', borderRadius: '50%', display: 'inline-flex' }}>
          <Avatar name={name} image={avatar} size={64} presence="online" tint={['#2a0f13', '#ff9aa3']} ring="#111214" />
        </span>
        <div style={{ fontWeight: 700, fontSize: 18, marginTop: 8 }}>{name}</div>
        <div className="hg-faint">@{handle}</div>
        {bio && (
          <div className="hg-muted" style={{ fontSize: 13, marginTop: 10, lineHeight: 1.45 }}>
            {bio}
          </div>
        )}
        <div className="hg-label" style={{ marginTop: 14 }}>
          Agents
        </div>
        <div className="hg-faint" style={{ fontSize: 13, marginTop: 6 }}>
          {agents.length ? agents.join(', ') : 'None linked yet'}
        </div>
      </div>
    </div>
  );
}

/** Step 2: link your agent. Creates the agent identity for this computer's node. */
export function LinkAgent({ onDone, onBack }: { onDone: () => void; onBack?: () => void }) {
  const store = useCommunity();
  const node = useNode();
  const models = node.data?.models.installed ?? [];
  const [model, setModel] = useState<string | null>(node.data?.models.storage.activeModel ?? models[0]?.contentHash ?? null);
  const [error, setError] = useState<string | null>(null);
  const p = store.myProfile();
  const link = async () => {
    const r = await store.linkAgent({ modelName: models.find((m) => m.contentHash === model)?.displayName ?? null });
    if (!r.ok) return setError(r.message);
    onDone();
  };
  return (
    <section aria-labelledby="agent-title" className="hg-modal" style={{ width: 620, padding: 34 }}>
      <div className="hg-faint" style={{ fontSize: 12 }}>
        Step 2 of 2
      </div>
      <h2 id="agent-title" style={{ fontSize: 28, marginTop: 4 }}>
        Link your agent
      </h2>
      <p className="hg-muted" style={{ marginTop: 6, lineHeight: 1.5 }}>
        Your agent is this computer&apos;s node. It shows as <span className="hg-mono">@{p?.handle ?? 'you'}/local-node</span> with an <span className="hg-tag agent">agent</span> tag and your handle.
      </p>
      <fieldset style={{ marginTop: 20, border: 0, padding: 0, display: 'grid', gap: 8 }}>
        <legend className="hg-field-label">Model</legend>
        {models.length === 0 && <p className="hg-notice">No local model yet. You can pick one later in Models and keys.</p>}
        {models.map((m) => (
          <label key={m.contentHash} className="hg-input" style={{ cursor: 'pointer' }}>
            <input type="radio" name="agent-model" checked={model === m.contentHash} onChange={() => setModel(m.contentHash)} style={{ flex: 'none' }} />
            {m.displayName}
            <span className="hg-faint" style={{ marginLeft: 'auto', fontSize: 12 }}>
              local
            </span>
          </label>
        ))}
        <label className="hg-input" style={{ opacity: 0.55 }} title="API mode is off in this release.">
          <input type="radio" name="agent-model" disabled style={{ flex: 'none' }} />
          Your API key
          <span className="hg-faint" style={{ marginLeft: 'auto', fontSize: 12 }}>
            keychain, Later
          </span>
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="hg-error" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
      <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 10 }}>
          {onBack && (
            <button type="button" className="hg-btn ghost" onClick={onBack}>
              Back
            </button>
          )}
          <button
            type="button"
            className="hg-link hg-faint"
            style={{ textDecoration: 'none' }}
            onClick={() => {
              prefs.set('profile-skipped', true);
              onDone();
            }}
          >
            Skip for now
          </button>
        </div>
        <button type="button" className="hg-btn primary" onClick={() => void link()}>
          Link agent and finish
        </button>
      </div>
    </section>
  );
}

/** 9.2 Profile setup (mockup 14), then "link your agent". */
export function ProfileSetup({ onFinish }: { onFinish: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  return (
    <div className="hg-stage">
      <BrandCorner />
      {step === 1 ? (
        <ProfileEditor
          onDone={() => setStep(2)}
          onSkip={() => {
            prefs.set('profile-skipped', true);
            onFinish();
          }}
        />
      ) : (
        <LinkAgent onDone={onFinish} onBack={() => setStep(1)} />
      )}
    </div>
  );
}
