import { useNode } from './api';
import { useNav } from './router';
import { ActivityPage } from './pages/activity';
import { PLANNED_PAGES, PlaceholderPage, SettingsPage } from './pages/other';
import { WalletPage } from './pages/wallet';
import { ModelsPage } from './pages/models';
import { SetupPage } from './pages/setup';
import { StorePage } from './pages/store';
import { HarnessPage } from './pages/harness';
import { LibraryPage } from './pages/library';
import { JoinReview, ReconsentPage, SwarmPage } from './pages/swarm';
import { Shell } from './ui/shell';

function View() {
  const { route } = useNav();
  const node = useNode();
  // First run opens Pick a cause instead of the Store (SPEC 3.1). Deep links still go where they point.
  const firstRun = node.isSuccess && node.data.setup === null;
  switch (route.name) {
    case 'store':
      return firstRun ? <SetupPage /> : <StorePage category={route.category} />;
    case 'setup':
      return <SetupPage />;
    case 'swarm':
      return <SwarmPage key={route.slug} slug={route.slug} />;
    case 'join':
      return <JoinReview key={route.slug} slug={route.slug} />;
    case 'reconsent':
      return <ReconsentPage key={route.membershipId} membershipId={route.membershipId} />;
    case 'model':
      return <ModelsPage highlight={route.slug} />;
    case 'models':
      return <ModelsPage />;
    case 'harness':
      return <HarnessPage key={route.slug} name={route.slug} />;
    case 'result':
      return <PlaceholderPage title="Result" body="Public results and verification receipts arrive in milestone M7." />;
    case 'library':
      return <LibraryPage />;
    case 'activity':
      return <ActivityPage />;
    case 'wallet':
      return <WalletPage />;
    case 'community':
    case 'publisher':
      return <PlaceholderPage {...PLANNED_PAGES[route.name]} />;
    case 'settings':
      return <SettingsPage />;
  }
}

export function App() {
  return (
    <Shell>
      <View />
    </Shell>
  );
}
