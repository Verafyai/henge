import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { RouterProvider } from './router';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

// HENGE_COMMUNITY_LAYOUT comes from the main process; the Henge layout starts at Home, v1 at the Store.
void window.swarm.getAppInfo().then((info) => {
  const community = info?.communityLayout === true;
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider initial={community ? { name: 'home' } : { name: 'store' }}>
          <App community={community} />
        </RouterProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
});
