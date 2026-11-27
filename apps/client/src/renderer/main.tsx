import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HengeApp } from './henge/app';
import { RouterProvider } from './router';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

// The Henge layout (spin-out spec v2, 9) is the only interface; it opens on Home.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider initial={{ name: 'home' }}>
        <HengeApp />
      </RouterProvider>
    </QueryClientProvider>
  </StrictMode>,
);
