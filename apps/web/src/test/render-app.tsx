import type { SessionDto } from '@shopfloor/contracts/mes-api';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, render } from '@testing-library/react';
import { createQueryClient, App } from '../app.tsx';
import { sessionKey } from '../auth/auth.tsx';
import { connectLiveToCache } from '../live/live-cache.ts';
import { LiveClient } from '../live/live-client.ts';
import { socketFactory } from './fake-socket.ts';
import { SESSION } from './fixtures.ts';

/** Runs an update and lets TanStack Query's batched notifications (a 0 ms timeout) reach React. */
export async function settle(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export interface RenderOptions {
  /**
   * The session the app starts with (#170): a supervisor by default, so screens show every write
   * but user administration; `null` for none (the app goes to `/login`); `'fetch'` to read it with
   * `GET /api/v1/session` from the stubbed fetch.
   */
  readonly session?: SessionDto | null | 'fetch';
  /**
   * `'stopped'` leaves the live client stopped, as a route without the desk shell finds it after a
   * reload (#311); by default it is started before the app renders.
   */
  readonly live?: 'started' | 'stopped';
}

/** The whole app at a path, with a fake socket the test drives and the stubbed fetch. */
export async function renderApp(
  path: string,
  { session = SESSION, live: liveState = 'started' }: RenderOptions = {},
) {
  const factory = socketFactory();
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 5_000 } });
  if (session !== 'fetch') queryClient.setQueryData(sessionKey, session);
  const live = new LiveClient({ url: 'ws://test/api/v1/ws', createSocket: factory.create });
  connectLiveToCache(live, queryClient);
  if (liveState === 'started') live.start();
  const history = createMemoryHistory({ initialEntries: [path] });
  const view = render(<App queryClient={queryClient} live={live} history={history} />);
  await act(async () => {
    await Promise.resolve();
  });
  return {
    ...view,
    factory,
    live,
    queryClient,
    history,
    open: () =>
      settle(() => {
        factory.last.open();
      }),
    drop: (code?: number) =>
      settle(() => {
        factory.last.drop(code);
      }),
    push: (...messages: Parameters<(typeof factory)['last']['receive']>[0][]) =>
      settle(() => {
        for (const message of messages) factory.last.receive(message);
      }),
  };
}
