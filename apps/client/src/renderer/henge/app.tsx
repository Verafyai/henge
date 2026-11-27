import { useEffect, useMemo, useState } from 'react';
import { useAuth, useNode } from '../api';
import { ActivityPage } from '../pages/activity';
import { HarnessPage } from '../pages/harness';
import { LibraryPage } from '../pages/library';
import { ModelsPage } from '../pages/models';
import { PLANNED_PAGES, PlaceholderPage } from '../pages/other';
import { SetupPage } from '../pages/setup';
import { StorePage } from '../pages/store';
import { JoinReview, ReconsentPage, SwarmPage } from '../pages/swarm';
import { WalletPage } from '../pages/wallet';
import { useNav } from '../router';
import { ChannelView, ThreadPanel } from './chat';
import { CreateHengePage } from './create';
import { CommunityProvider, createCommunityStore, prefs, UiProvider, useCommunity, useCommunitySync, useLocalHenges, useUi } from './data';
import { AddGlyphModal } from './glyphs';
import { EmptyState, HomeFrame, UserSettings, YourHenges } from './home';
import { AddHengePage } from './join';
import { ProfileSetup, SignInScreen } from './onboarding';
import { HengeSettings } from './settings';
import { Frame, HengeColumn, MemberList, ProfilePopover, TitleStrip } from './shell';
import './henge.css';

function Notices() {
  const [msgs, setMsgs] = useState<Array<{ id: number; text: string }>>([]);
  useEffect(
    () =>
      window.swarm.onNotice((text) => {
        const id = Date.now() + Math.random();
        setMsgs((m) => [...m, { id, text }]);
        setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 6000);
      }),
    [],
  );
  if (!msgs.length) return null;
  return (
    <div style={{ position: 'fixed', bottom: 70, right: 16, zIndex: 60, display: 'grid', gap: 8, pointerEvents: 'none' }} aria-live="polite">
      {msgs.map((m) => (
        <p key={m.id} role="status" style={{ background: '#1a1b1e', borderRadius: 8, padding: '8px 14px', fontSize: 13, boxShadow: '0 10px 30px rgba(0,0,0,.5)' }}>
          {m.text}
        </p>
      ))}
    </div>
  );
}

function HengeView({ hengeKey, channel }: { hengeKey: string; channel?: string }) {
  const henges = useLocalHenges();
  const store = useCommunity();
  const { go } = useNav();
  const [threadState, setThreadState] = useState<{ channel?: string; id: string } | null>(null);
  const thread = threadState && threadState.channel === channel ? threadState.id : null;
  const setThread = (id: string | null) => setThreadState(id ? { channel, id } : null);
  const [showMembers, setShowMembers] = useState(true);
  const h = henges.data?.find((x) => x.key === hengeKey);
  useEffect(() => {
    if (henges.isSuccess && !h) go({ name: 'home' });
  }, [henges.isSuccess, h, go]);
  if (!h) return null;
  const channels = store.channels(h.key);
  const ch = channels.find((c) => c.id === channel) ?? channels.find((c) => c.type === 'text') ?? channels[0];
  if (!ch)
    return <Frame column={<HengeColumn h={h} />} main={<main className="hg-main" style={{ padding: 40 }}><p className="hg-muted">This Henge declares no channels.</p></main>} />;
  return (
    <Frame
      variant={thread ? 'thread' : showMembers ? undefined : 'no-members'}
      column={<HengeColumn h={h} channelId={ch.id} />}
      main={<ChannelView h={h} channel={ch} onThread={setThread} showMembers={showMembers} onToggleMembers={() => setShowMembers((s) => !s)} />}
      right={thread ? <ThreadPanel h={h} rootId={thread} onClose={() => setThread(null)} /> : showMembers ? <MemberList hengeKey={h.key} /> : undefined}
    />
  );
}

function Routes() {
  const { route } = useNav();
  const node = useNode();
  const henges = useLocalHenges();
  const firstRun = node.isSuccess && node.data.setup === null;
  switch (route.name) {
    case 'home':
      return henges.isSuccess && henges.data.length === 0 ? <Frame main={<EmptyState />} /> : <HomeFrame title="Your Henges"><YourHenges /></HomeFrame>;
    case 'henge':
      return <HengeView key={route.key} hengeKey={route.key} channel={route.channel} />;
    case 'henge-settings': {
      const h = henges.data?.find((x) => x.key === route.key);
      return h ? <HengeSettings h={h} section={route.section} glyph={route.glyph} channel={route.channel} /> : null;
    }
    case 'add-henge':
      return <AddHengePage key={route.url ?? ''} initialUrl={route.url} />;
    case 'create-henge':
      return <CreateHengePage />;
    case 'user-settings':
      return <UserSettings section={route.section} />;
    case 'settings':
      return <UserSettings section="account" />;
    case 'store':
      return <HomeFrame title={firstRun ? 'Pick a cause' : 'Store'}>{firstRun ? <SetupPage /> : <StorePage category={route.category} />}</HomeFrame>;
    case 'setup':
      return <HomeFrame title="Pick a cause"><SetupPage /></HomeFrame>;
    case 'swarm':
      return <HomeFrame title="Swarm"><SwarmPage key={route.slug} slug={route.slug} /></HomeFrame>;
    case 'join':
      return <HomeFrame title="Review before joining"><JoinReview key={route.slug} slug={route.slug} /></HomeFrame>;
    case 'reconsent':
      return <HomeFrame title="Review new permissions"><ReconsentPage key={route.membershipId} membershipId={route.membershipId} /></HomeFrame>;
    case 'model':
      return <HomeFrame title="Models"><ModelsPage highlight={route.slug} /></HomeFrame>;
    case 'models':
      return <HomeFrame title="Models"><ModelsPage /></HomeFrame>;
    case 'harness':
      return <HomeFrame title="Harness"><HarnessPage key={route.slug} name={route.slug} /></HomeFrame>;
    case 'result':
      return <HomeFrame title="Result"><PlaceholderPage title="Result" body="Public results and verification receipts arrive in milestone M7." /></HomeFrame>;
    case 'library':
      return <HomeFrame title="Library"><LibraryPage /></HomeFrame>;
    case 'activity':
      return <HomeFrame title="Activity"><ActivityPage /></HomeFrame>;
    case 'wallet':
      return <HomeFrame title="Wallet"><WalletPage /></HomeFrame>;
    case 'community':
    case 'publisher':
      return <HomeFrame><PlaceholderPage {...PLANNED_PAGES[route.name]} /></HomeFrame>;
  }
}

function Gate() {
  const auth = useAuth();
  const store = useCommunity();
  const ui = useUi();
  const { route } = useNav();
  const [local, setLocal] = useState(() => prefs.get('local-mode'));
  const [profileDone, setProfileDone] = useState(() => prefs.get('profile-skipped'));
  const [setupOpen, setSetupOpen] = useState(false);
  useCommunitySync();
  if (auth.status !== 'signed_in' && !local)
    return (
      <SignInScreen
        onLocal={() => {
          prefs.set('local-mode', true);
          setLocal(true);
        }}
      />
    );
  // Stays open through step 2 (link your agent) even though the profile now exists.
  const needsProfile = auth.status === 'signed_in' && store.ready() && !store.myProfile() && !profileDone;
  if (needsProfile && !setupOpen) setSetupOpen(true);
  if (setupOpen && auth.status === 'signed_in')
    return (
      <ProfileSetup
        onFinish={() => {
          setProfileDone(true);
          setSetupOpen(false);
        }}
      />
    );
  return (
    <>
      <Routes />
      {ui.addGlyph && <AddGlyphModal hengeKey={ui.addGlyph} />}
      <ProfilePopover hengeKey={route.name === 'henge' ? route.key : null} />
    </>
  );
}

/** The Henge layout (spin-out spec v2, 9): the app's only interface. */
export function HengeApp() {
  const store = useMemo(() => createCommunityStore(), []);
  const auth = useAuth();
  return (
    <CommunityProvider store={store}>
      <UiProvider>
        <div className="hg" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--hg-page)' }}>
          <TitleStrip />
          {auth.error && auth.status === 'signed_out' && (
            <p role="alert" style={{ padding: '8px 16px', fontSize: 13, background: '#231a07', color: '#e8c36f', borderBottom: '1px solid #4d3a10' }}>
              {auth.error}
            </p>
          )}
          <Gate />
          <Notices />
        </div>
      </UiProvider>
    </CommunityProvider>
  );
}
