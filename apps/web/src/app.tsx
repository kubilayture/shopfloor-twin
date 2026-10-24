import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useState } from 'react';
import { shouldRetry } from './api/queries.ts';
import { AuthEvents, bindAuthEvents } from './auth/events.ts';
import { ToastRegion } from './components/ui/toast.tsx';
import type { LiveClient } from './live/live-client.ts';
import { LiveProvider } from './live/live-context.tsx';
import { createAppRouter } from './router.tsx';

/**
 * The query client. Every failed query or mutation is reported to the client's `AuthEvents`: a 401,
 * or a 403 that asks for a password change, sends the app to its login (#170). The session query
 * and the login forms handle their own answers (`meta: { auth: false }`).
 */
export function createQueryClient(): QueryClient {
  const events = new AuthEvents();
  const report = (error: unknown, meta: Record<string, unknown> | undefined) => {
    if (meta?.auth !== false) events.report(error);
  };
  const client = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        report(error, query.meta);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        report(error, mutation.meta);
      },
    }),
    // `always` (#312): offline, a read fails within its retries and shows its error, and a write
    // fails at once where the form shows a refused one; neither waits, paused, for the network
    // (TanStack's `online` mode), which left screens "Loading…" and queued writes to send later.
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 5_000, networkMode: 'always' },
      mutations: { networkMode: 'always' },
    },
  });
  bindAuthEvents(client, events);
  return client;
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
        {/* Toasts (#317) outside the routes: one region for the whole app, the terminal too. */}
        <ToastRegion />
      </LiveProvider>
    </QueryClientProvider>
  );
}
