import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useState } from 'react';
import { shouldRetry } from './api/queries.ts';
import type { LiveClient } from './live/live-client.ts';
import { LiveProvider } from './live/live-context.tsx';
import { createAppRouter } from './router.tsx';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: shouldRetry, staleTime: 5_000 } },
  });
}

export function App({
  queryClient,
  live,
  history,
}: {
  queryClient: QueryClient;
  live: LiveClient;
  history?: RouterHistory;
}) {
  const [router] = useState(() => createAppRouter(history));
  return (
    <QueryClientProvider client={queryClient}>
      <LiveProvider client={live}>
        <RouterProvider router={router} />
      </LiveProvider>
    </QueryClientProvider>
  );
}
