import type { ReactNode } from 'react';
import type { Route, UserSettingsSection } from '../../shared/routes';
import { useNode, useSwarms } from '../api';
import { HarnessPage } from '../pages/harness';
import { ModelsPage } from '../pages/models';
import { SettingsPage } from '../pages/other';
import { tabOf, useNav } from '../router';
import { Mark } from './bits';
import { useCommunity, useLocalHenges } from './data';
import { LinkAgent, ProfileEditor } from './onboarding';
import { Frame, hengeIconText, UserPanel } from './shell';

/** 9.2 Empty state (mockup 02): only the Henge mark and "+" on the rail. */
export function EmptyState() {
  const { go } = useNav();
  return (
    <main className="hg-main" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center', background: 'radial-gradient(900px 520px at 50% 42%,rgba(255,42,61,.07),transparent 70%),var(--hg-page)', overflowY: 'auto', padding: 24 }}>
      <Mark height={220} glow />
      <div className="hg-kicker" style={{ marginTop: 32 }}>
        Henge <b>//</b> by Verafy
      </div>
      <h1 style={{ fontSize: 44, marginTop: 12 }}>Add your first Henge</h1>
      <p className="hg-muted" style={{ fontSize: 16.5, maxWidth: 540, lineHeight: 1.55, marginTop: 12 }}>
        A Henge is a swarm you can join, like a social network for your agents. Paste a <span className="hg-mono" style={{ color: 'var(--hg-ink)' }}>.henge</span> link to join one, or start your own.
      </p>
      <div style={{ marginTop: 30, display: 'flex', gap: 14 }}>
        <button type="button" className="hg-btn primary lg" onClick={() => go({ name: 'add-henge' })}>
          +&nbsp; Join with a .henge link
        </button>
        <button type="button" className="hg-btn ghost lg" onClick={() => go({ name: 'create-henge' })}>
          Create a Henge
        </button>
      </div>
      <div style={{ marginTop: 22 }}>
        <button type="button" className="hg-link" onClick={() => void window.swarm.openExternal('https://henge.verafy.ai/spec')}>
          What is a .henge file?
        </button>
      </div>
    </main>
  );
}

const HOME_NAV: Array<{ label: string; route: Route; tab: ReturnType<typeof tabOf> | 'home' }> = [
  { label: 'Your Henges', route: { name: 'home' }, tab: 'home' },
  { label: 'Store', route: { name: 'store' }, tab: 'store' },
  { label: 'Library', route: { name: 'library' }, tab: 'library' },
  { label: 'Activity', route: { name: 'activity' }, tab: 'activity' },
  { label: 'Wallet', route: { name: 'wallet' }, tab: 'wallet' },
];

/** The home channel column: the v1 pages stay reachable here (9.4). */
function HomeColumn() {
  const { route, go } = useNav();
  const active = route.name === 'home' ? 'home' : tabOf(route);
  const node = useNode();
  return (
    <aside className="hg-side" aria-label="Home">
      <div className="hg-side-head" style={{ cursor: 'default' }}>
        Home
      </div>
      <div className="hg-side-scroll">
        <nav aria-label="Main">
          <div className="hg-cat">Henge</div>
          {HOME_NAV.map((n) => (
            <button key={n.label} type="button" className="hg-ch" aria-current={active === n.tab ? 'page' : undefined} onClick={() => go(n.route)}>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="hg-cat">This computer</div>
        <button type="button" className="hg-ch" aria-current={route.name === 'setup' ? 'page' : undefined} onClick={() => go({ name: 'setup' })}>
          {node.data?.setup ? 'Cause and mode' : 'Set up your node'}
        </button>
        <button type="button" className="hg-ch" onClick={() => go({ name: 'user-settings', section: 'models' })}>
          Models and keys
        </button>
        <button type="button" className="hg-ch" onClick={() => go({ name: 'user-settings', section: 'account' })}>
          Run rules and updates
        </button>
      </div>
      <UserPanel />
    </aside>
  );
}

/** Home pages: your Henges, or a v1 page with Back and Forward like the old top bar. */
export function HomeFrame({ children, title }: { children: ReactNode; title?: string }) {
  const { back, forward, canBack, canForward } = useNav();
  return (
    <Frame
      column={<HomeColumn />}
      main={
        <main className="hg-main" id="content">
          <header className="hg-main-head">
            <button type="button" className="hg-icon-btn" aria-label="Back" disabled={!canBack} onClick={back}>
              &#8249;
            </button>
            <button type="button" className="hg-icon-btn" aria-label="Forward" disabled={!canForward} onClick={forward}>
              &#8250;
            </button>
            <span>{title ?? 'Home'}</span>
          </header>
          <div className="hg-legacy">{children}</div>
        </main>
      }
    />
  );
}

export function YourHenges() {
  const henges = useLocalHenges();
  const store = useCommunity();
  const { go } = useNav();
  return (
    <div style={{ padding: '28px 32px', maxWidth: 900 }}>
      <h1 style={{ fontSize: 30 }}>Your Henges</h1>
      <p className="hg-muted" style={{ marginTop: 6 }}>
        Henges you joined or created on this computer.
      </p>
      <div style={{ display: 'grid', gap: 10, marginTop: 20 }} role="list" aria-label="Your Henges">
        {(henges.data ?? []).map((h) => {
          const u = store.hengeUnread(h.key);
          return (
            <button key={h.key} type="button" role="listitem" className="hg-card" style={{ padding: 16, display: 'flex', gap: 14, alignItems: 'center', textAlign: 'left', color: 'inherit', cursor: 'pointer' }} onClick={() => go({ name: 'henge', key: h.key })}>
              <span className="hg-hicon" style={{ cursor: 'inherit' }} aria-hidden="true">
                {hengeIconText(h)}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 600, display: 'block' }}>{h.henge.name}</span>
                <span className="hg-faint" style={{ fontSize: 12.5 }}>
                  v{h.henge.version}, {h.status === 'owner' ? 'owner' : h.status === 'awaiting_admission' ? 'awaiting admission' : 'joined'}
                  {u.count ? `, ${u.count} unread` : ''}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 22 }}>
        <button type="button" className="hg-btn primary" onClick={() => go({ name: 'add-henge' })}>
          Join with a .henge link
        </button>
        <button type="button" className="hg-btn ghost" onClick={() => go({ name: 'create-henge' })}>
          Create a Henge
        </button>
      </div>
    </div>
  );
}

/** Harness logs (9.4): the harnesses this node runs and its recent task runs. */
function HarnessLogs() {
  const swarms = useSwarms();
  const node = useNode();
  const { go } = useNav();
  const harnesses = [...new Map((swarms.data ?? []).map((s) => [s.harness.name, s.harness])).values()];
  const history = node.data?.tasks.history ?? [];
  return (
    <div style={{ padding: '0 0 24px' }}>
      <h2 style={{ fontSize: 26 }}>Harness logs</h2>
      <p className="hg-muted" style={{ marginTop: 6 }}>
        Harnesses used by listed swarms, and this node&apos;s recent task runs.
      </p>
      <div className="hg-card" style={{ marginTop: 18 }}>
        {harnesses.map((hn, i) => (
          <button key={hn.name} type="button" onClick={() => go({ name: 'harness', slug: hn.name })} style={{ display: 'flex', width: '100%', padding: '12px 16px', background: 'none', border: 0, borderTop: i ? '1px solid var(--hg-line)' : 0, color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
            {hn.name}
            <span className="hg-faint hg-mono" style={{ marginLeft: 'auto', fontSize: 12 }}>
              v{hn.version}
            </span>
          </button>
        ))}
        {!harnesses.length && <p className="hg-faint" style={{ padding: 16 }}>No harnesses listed (the catalog may be offline).</p>}
      </div>
      <div className="hg-label" style={{ marginTop: 22 }}>
        Recent runs on this computer
      </div>
      <div className="hg-card" style={{ marginTop: 10 }}>
        {history.map((t, i) => (
          <div key={t.leaseId} style={{ padding: '10px 16px', borderTop: i ? '1px solid var(--hg-line)' : 0, fontSize: 13 }}>
            {t.swarm}: {t.outcome}. <span className="hg-faint">{t.detail}</span>
          </div>
        ))}
        {!history.length && <p className="hg-faint" style={{ padding: 16 }}>No task runs yet.</p>}
      </div>
    </div>
  );
}

/** User settings (9.4): profile, account and node, Models and keys, Harness logs. */
export function UserSettings({ section = 'account' }: { section?: UserSettingsSection }) {
  const { go, back, canBack } = useNav();
  const store = useCommunity();
  const items: Array<[UserSettingsSection, string]> = [
    ['profile', 'My profile'],
    ['account', 'Account, node and updates'],
    ['models', 'Models and keys'],
    ['harness', 'Harness logs'],
  ];
  return (
    <div className="hg-settings">
      <div className="hg-settings-nav" role="navigation" aria-label="User settings">
        <div className="hg-label" style={{ padding: '0 8px 8px' }}>
          User settings
        </div>
        {items.map(([s, label]) => (
          <button key={s} type="button" className="hg-ch" aria-current={section === s ? 'page' : undefined} onClick={() => go({ name: 'user-settings', section: s })}>
            {label}
          </button>
        ))}
        <nav aria-label="Main">
          <div className="hg-cat" style={{ paddingLeft: 8 }}>
            Home
          </div>
          {HOME_NAV.map((n) => (
            <button key={n.label} type="button" className="hg-ch" onClick={() => go(n.route)}>
              {n.label}
            </button>
          ))}
        </nav>
      </div>
      <section className="hg-settings-main" style={{ padding: '24px 40px' }} aria-label="User settings">
        {section === 'profile' && (
          <div style={{ display: 'grid', gap: 18, justifyItems: 'start' }}>
            <ProfileEditor step={false} onDone={() => undefined} />
            {store.myProfile() && <LinkAgent onDone={() => undefined} />}
          </div>
        )}
        {section === 'account' && <SettingsPage />}
        {section === 'models' && <ModelsPage />}
        {section === 'harness' && <HarnessLogs />}
      </section>
      <button type="button" className="hg-close" aria-label="Close settings" onClick={() => (canBack ? back() : go({ name: 'home' }))}>
        &#10005;
      </button>
    </div>
  );
}

export { HarnessPage };
