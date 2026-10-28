import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_CHECK_MAX_MS } from '../screens/login.tsx';
import { PASSWORD, fakeMes } from '../test/fake-mes.ts';
import { json, problem } from '../test/fixtures.ts';
import { renderApp, settle } from '../test/render-app.tsx';
import { createQueryClient } from '../app.tsx';
import { LiveProvider } from '../live/live-context.tsx';
import { LiveClient } from '../live/live-client.ts';
import { socketFactory } from '../test/fake-socket.ts';
import { AuthProvider, sessionKey, useAuth, type Auth } from './auth.tsx';
import { KEEPALIVE_MS } from './idle.ts';
import {
  LAST_LOGIN_KEY,
  LOGOUT_PENDING_KEY,
  LOGOUT_PENDING_MAX_AGE_MS,
  LOGOUT_REPLAY_TIMEOUT_MS,
  markLogout,
} from './pending-logout.ts';

// A logout and a read of the session racing at the MES (#390, the demo's scene 8 flake): a read
// the MES answered before the logout ended the session must not sign its user back in, and the
// late "session ended" that would follow must neither show nor wipe the login's typed name. A
// logout replayed by a later page ends only the session it was ending (#392 review).

/** An in-memory `Storage` (this jsdom's storages may be missing). */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const requestOf = (input: RequestInfo | URL, init?: RequestInit) => ({
  method: init?.method ?? 'GET',
  path: new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost')
    .pathname,
});

const SESSION_PATH = '/api/v1/session';

/**
 * The fake MES with hooks: `hold(method)` makes the next such request of `/session` wait for the
 * returned gate. `answered: true` lets the MES answer it now (the session as it is now) and only
 * delivers the answer when the gate opens; otherwise the MES sees the request only then.
 */
function racingMes(options: Parameters<typeof fakeMes>[0] = {}) {
  const mes = fakeMes(options);
  const holds: { method: string; answered: boolean; opened: Promise<void> }[] = [];
  const fetch: Fetch = (input, init) => {
    const { method, path } = requestOf(input, init);
    const at = path === SESSION_PATH ? holds.findIndex((h) => h.method === method) : -1;
    if (at >= 0) {
      const [held] = holds.splice(at, 1);
      if (held?.answered) {
        const answer = mes.fetch(input, init);
        return held.opened.then(() => answer);
      }
      return (held?.opened ?? Promise.resolve()).then(() => mes.fetch(input, init));
    }
    return mes.fetch(input, init);
  };
  const hold = (method: string, answered = false) => {
    const g = gate();
    holds.push({ method, answered, opened: g.opened });
    return g.open;
  };
  const sessionCalls = () => mes.calls.filter((c) => c.path === SESSION_PATH);
  return { ...mes, fetch, hold, sessionCalls };
}

let tabStorage = memoryStorage();
let browserStorage = memoryStorage();
beforeEach(() => {
  tabStorage = memoryStorage();
  browserStorage = memoryStorage();
  vi.stubGlobal('sessionStorage', tabStorage);
  vi.stubGlobal('localStorage', browserStorage);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const markOf = () => JSON.parse(tabStorage.getItem(LOGOUT_PENDING_KEY) ?? 'null') as unknown;

async function signedInAt(path: string, mes: ReturnType<typeof racingMes>) {
  vi.stubGlobal('fetch', mes.fetch);
  const app = await renderApp(path, { session: 'fetch' });
  await app.open();
  await screen.findByTestId('signed-in-user');
  return app;
}

async function logInAs(username: string) {
  fireEvent.change(await screen.findByTestId('login-username'), { target: { value: username } });
  fireEvent.change(screen.getByTestId('login-password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByTestId('login-submit'));
}

describe('a logout racing a read of the session, in one page', () => {
  it('ignores a read the MES answered before the logout ended the session', async () => {
    const mes = racingMes({ signedIn: true });
    const app = await signedInAt('/', mes);
    // A read in flight (a 403's or a 4403's), answered as `ayse`, received after the logout.
    const release = mes.hold('GET', true);
    await settle(() => {
      void app.queryClient.invalidateQueries({ queryKey: sessionKey });
    });
    fireEvent.click(screen.getByTestId('logout'));
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/login');
    });
    await settle(release);
    await settle(() => undefined);
    expect(app.queryClient.getQueryData(sessionKey)).toBeNull();
    expect(screen.queryByTestId('signed-in-user')).toBeNull();
    expect(screen.getByTestId('login-reason').dataset.reason).toBe('logout');
  });

  it('holds a read begun after the logout until the MES has ended the session (M1)', async () => {
    const mes = racingMes({ signedIn: true });
    const app = await signedInAt('/', mes);
    const release = mes.hold('DELETE');
    fireEvent.click(screen.getByTestId('logout'));
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/login');
    });
    const before = mes.sessionCalls().length;
    // A 403 answered for the page just left reads the session again, during the logout.
    await settle(() => {
      void app.queryClient.invalidateQueries({ queryKey: sessionKey });
    });
    expect(mes.sessionCalls().length).toBe(before);
    await settle(release);
    await settle(() => undefined);
    expect(mes.sessionCalls().map((c) => c.method)).toEqual(['GET', 'DELETE', 'GET']);
    expect(app.queryClient.getQueryData(sessionKey)).toBeNull();
    expect(screen.getByTestId('login-reason').dataset.reason).toBe('logout');
  });

  it("ignores the idle keepalive's read when a logout came meanwhile", async () => {
    const mes = racingMes({ signedIn: true });
    const app = await signedInAt('/', mes);
    const reads = mes.sessionCalls().length;
    const release = mes.hold('GET', true);
    // Input past the keepalive interval reads the session (`refresh`), answered as `ayse`.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + KEEPALIVE_MS + 1);
    await settle(() => {
      fireEvent.keyDown(window, { key: 'a' });
    });
    expect(mes.sessionCalls().length).toBe(reads + 1);
    fireEvent.click(screen.getByTestId('logout'));
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/login');
    });
    await settle(release);
    await settle(() => undefined);
    expect(app.queryClient.getQueryData(sessionKey)).toBeNull();
    expect(screen.getByTestId('login-reason').dataset.reason).toBe('logout');
  });

  it('keeps a login when a read begun before it answers after it (M2)', async () => {
    const mes = racingMes();
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/login', { session: 'fetch', live: 'stopped' });
    await screen.findByTestId('login-username');
    // A read in flight, answered "no session" by the MES before the login.
    const release = mes.hold('GET', true);
    await settle(() => {
      void app.queryClient.invalidateQueries({ queryKey: sessionKey });
    });
    await logInAs('ayse');
    expect((await screen.findByTestId('signed-in-user')).textContent).toBe('ayse');
    await settle(release);
    await settle(() => undefined);
    expect(app.queryClient.getQueryData(sessionKey)).toMatchObject({ user: { username: 'ayse' } });
    expect(screen.getByTestId('signed-in-user').textContent).toBe('ayse');
  });

  it('ends an idle session as a logout does: marked, waited for by reads and the login (L3)', async () => {
    const mes = racingMes({ signedIn: true });
    const app = await signedInAt('/', mes);
    const created = mes.current()?.createdAt;
    const release = mes.hold('DELETE');
    // Two hours without use: the idle timeout here ends the session (the 1 s tick sees it).
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60_000);
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/login');
    });
    expect(markOf()).toMatchObject({ createdAt: created });
    expect(screen.getByTestId('login-submit').textContent).toContain('Logging out…');
    const before = mes.sessionCalls().length;
    await settle(() => {
      void app.queryClient.invalidateQueries({ queryKey: sessionKey });
    });
    expect(mes.sessionCalls().length).toBe(before);
    await settle(release);
    await settle(() => undefined);
    expect(mes.current()).toBeNull();
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    expect(app.queryClient.getQueryData(sessionKey)).toBeNull();
    expect(screen.getByTestId('login-reason').dataset.reason).toBe('idle');
    expect(screen.getByTestId('login-submit').textContent).toBe('Log in');
  });
});

describe('refresh during a logout', () => {
  it('reads the session only once the logout on its way has ended it', async () => {
    const mes = racingMes({ signedIn: true });
    vi.stubGlobal('fetch', mes.fetch);
    const queryClient = createQueryClient();
    const live = new LiveClient({
      url: 'ws://test/api/v1/ws',
      createSocket: socketFactory().create,
    });
    let auth: Auth | undefined;
    function Probe() {
      auth = useAuth();
      return null;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <LiveProvider client={live}>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </LiveProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(auth?.session?.user.username).toBe('ayse');
    });
    const release = mes.hold('DELETE');
    let ended: Promise<void> | undefined;
    let refreshed: Promise<void> | undefined;
    await settle(() => {
      ended = auth?.logOut();
      // Started after the logout, while its DELETE is on its way: answered after it.
      refreshed = auth?.refresh();
    });
    await settle(release);
    await act(async () => {
      await Promise.all([ended, refreshed]);
    });
    expect(mes.sessionCalls().map((c) => c.method)).toEqual(['GET', 'DELETE', 'GET']);
    expect(queryClient.getQueryData(sessionKey)).toBeNull();
    // Nothing was lost: the user logged out.
    expect(auth?.ended).toBe('logout');
  });
});

describe('a logout a page left on its way, replayed by the next page of the tab', () => {
  it('ends that session before the first read, and the login is not disturbed after', async () => {
    const mes = racingMes({ signedIn: true });
    const first = await signedInAt('/', mes);
    const created = mes.current()?.createdAt;
    // The first page's logout reaches the MES only after the next page's reads.
    const cutOff = mes.hold('DELETE');
    fireEvent.click(screen.getByTestId('logout'));
    await waitFor(() => {
      expect(first.history.location.pathname).toBe('/login');
    });
    expect(markOf()).toMatchObject({ createdAt: created });
    // The test goes to /login at once (`page.goto`): a new document, the logout on its way.
    first.unmount();
    const callsBefore = mes.sessionCalls().length;
    const second = await renderApp('/login', { session: 'fetch', live: 'stopped' });
    const username = await screen.findByTestId<HTMLInputElement>('login-username');
    const replay = mes.sessionCalls().slice(callsBefore);
    expect(replay.map((c) => c.method)).toEqual(['DELETE', 'GET']);
    expect(replay[0]?.body).toEqual({ createdAt: created });
    expect(second.queryClient.getQueryData(sessionKey)).toBeNull();
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    fireEvent.change(username, { target: { value: 'demo-quality' } });
    // The cut-off logout lands now; nothing on this page was signed in, so nothing is "lost".
    await settle(cutOff);
    await settle(() => {
      void second.queryClient.invalidateQueries();
    });
    expect(second.history.location.pathname).toBe('/login');
    expect(screen.queryByTestId('login-reason')).toBeNull();
    expect(screen.getByTestId<HTMLInputElement>('login-username').value).toBe('demo-quality');
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByTestId('login-submit'));
    expect((await screen.findByTestId('signed-in-user')).textContent).toBe('demo-quality');
  });

  it('never ends a newer session the cookie holds by then (H1)', async () => {
    const mes = racingMes({ signedIn: true });
    // A mark for a session created earlier; another login (another tab's) holds the cookie now.
    const older = new Date(Date.now() - 10 * 60_000).toISOString();
    markLogout(older);
    vi.stubGlobal('fetch', mes.fetch);
    await renderApp('/', { session: 'fetch' });
    expect((await screen.findByTestId('signed-in-user')).textContent).toBe('ayse');
    const deletes = mes.sessionCalls().filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.body)).toEqual([{ createdAt: older }]);
    expect(mes.current()).not.toBeNull();
    // The MES answered: the mark is gone.
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it.each([
    ['older than its maximum age', () => Date.now() - LOGOUT_PENDING_MAX_AGE_MS - 1, () => 0],
    ['dated in the future (the clock went back)', () => Date.now() + 60_000, () => 0],
    ['older than a login in any tab', () => Date.now() - 1_000, () => Date.now() - 500],
  ])('drops a mark %s without replaying it', async (_name, at, loggedInAt) => {
    const mes = racingMes({ signedIn: true });
    const created = mes.current()?.createdAt ?? '';
    markLogout(created, at());
    const login = loggedInAt();
    if (login > 0) browserStorage.setItem(LAST_LOGIN_KEY, String(login));
    vi.stubGlobal('fetch', mes.fetch);
    await renderApp('/', { session: 'fetch' });
    expect((await screen.findByTestId('signed-in-user')).textContent).toBe('ayse');
    expect(mes.sessionCalls().filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it('drops an unreadable mark without replaying it', async () => {
    const mes = racingMes({ signedIn: true });
    tabStorage.setItem(LOGOUT_PENDING_KEY, '{"createdAt":1}');
    vi.stubGlobal('fetch', mes.fetch);
    await renderApp('/', { session: 'fetch' });
    expect((await screen.findByTestId('signed-in-user')).textContent).toBe('ayse');
    expect(mes.sessionCalls().filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it('keeps the mark when the replay fails, for the next page (L2)', async () => {
    const mes = racingMes({ signedIn: true });
    markLogout(mes.current()?.createdAt ?? '');
    const kept = tabStorage.getItem(LOGOUT_PENDING_KEY);
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      requestOf(input, init).method === 'DELETE'
        ? Promise.resolve(problem(503, 'Service Unavailable', 'db', SESSION_PATH))
        : mes.fetch(input, init),
    );
    await renderApp('/', { session: 'fetch' });
    await screen.findByTestId('signed-in-user');
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).toBe(kept);
  });

  it('reads the session after the replay times out, keeping the mark (L1, L2)', async () => {
    const mes = racingMes();
    markLogout(new Date().toISOString());
    let aborted = 0;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestOf(input, init).method !== 'DELETE') return mes.fetch(input, init);
      // A MES that takes the request and never answers.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = Date.now();
          reject(new DOMException('timed out', 'TimeoutError'));
        });
      });
    });
    const started = Date.now();
    await renderApp('/login', { session: 'fetch', live: 'stopped' });
    await waitFor(
      () => {
        expect(mes.sessionCalls().filter((c) => c.method === 'GET')).toHaveLength(1);
      },
      { timeout: LOGOUT_REPLAY_TIMEOUT_MS + 2_000 },
    );
    expect(aborted - started).toBeGreaterThanOrEqual(LOGOUT_REPLAY_TIMEOUT_MS - 50);
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).not.toBeNull();
    expect(await screen.findByTestId('login-username')).toBeTruthy();
  });

  it("clears the mark once the MES answered; keeps it when it didn't; a login clears it", async () => {
    const mes = racingMes({ signedIn: true });
    const app = await signedInAt('/', mes);
    fireEvent.click(screen.getByTestId('logout'));
    await waitFor(() => {
      expect(screen.getByTestId('login-submit').textContent).toBe('Log in');
    });
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    // A login: the mark of this tab goes, and every tab learns of the login.
    markLogout('2026-10-01T00:00:00.000Z');
    const before = Date.now();
    await logInAs('ayse');
    await screen.findByTestId('signed-in-user');
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    expect(Number(browserStorage.getItem(LAST_LOGIN_KEY))).toBeGreaterThanOrEqual(before);
    // A logout the MES refuses (unreachable): the mark stays for the next page.
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      requestOf(input, init).method === 'DELETE'
        ? Promise.reject(new TypeError('unreachable'))
        : mes.fetch(input, init),
    );
    fireEvent.click(screen.getByTestId('logout'));
    await waitFor(() => {
      expect(screen.getByTestId('login-submit').textContent).toBe('Log in');
    });
    expect(markOf()).toMatchObject({ createdAt: expect.any(String) as unknown });
    expect(app.history.location.pathname).toBe('/login');
  });

  it('reads the session as usual when the storage refuses', async () => {
    const mes = racingMes({ signedIn: true });
    const refuse = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('sessionStorage', { getItem: refuse, setItem: refuse, removeItem: refuse });
    vi.stubGlobal('localStorage', { getItem: refuse, setItem: refuse, removeItem: refuse });
    await signedInAt('/', mes);
    expect(screen.getByTestId('signed-in-user').textContent).toBe('ayse');
    expect(mes.sessionCalls().filter((c) => c.method === 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('logout'));
    await waitFor(() => {
      expect(screen.getByTestId('login-submit').textContent).toBe('Log in');
    });
    expect(mes.current()).toBeNull();
  });
});

describe('the login while the session is read', () => {
  it('shows no form until the session is known, busy, so nothing typed is dropped', async () => {
    const mes = racingMes({ signedIn: true });
    const release = mes.hold('GET');
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/login', { session: 'fetch', live: 'stopped' });
    expect(screen.queryByTestId('login-username')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Checking your session…');
    expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Signed in already: on to the page, never a form to type into first.
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/');
    });
  });

  it('shows the form, not busy, once the read finds no session', async () => {
    vi.stubGlobal('fetch', fakeMes().fetch);
    await renderApp('/login', { session: 'fetch', live: 'stopped' });
    await screen.findByTestId('login-username');
    expect(screen.getByRole('main').getAttribute('aria-busy')).toBeNull();
  });

  it.each([
    ['unreachable', () => Promise.reject(new TypeError('unreachable'))],
    ['answering 503', () => Promise.resolve(problem(503, 'Unavailable', 'down', SESSION_PATH))],
  ])('shows the form at the first failed read, before any retry: MES %s', async (_n, answer) => {
    let reads = 0;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestOf(input, init).path === SESSION_PATH) reads += 1;
      return answer();
    });
    // The app's retries (`shouldRetry` retries 0 and 5xx after 1 s, 2 s, 4 s).
    await renderApp('/login', { session: 'fetch', live: 'stopped', retry: 'app' });
    await screen.findByTestId('login-username', {}, { timeout: 500 });
    expect(reads).toBe(1);
  });

  it('shows the form after SESSION_CHECK_MAX_MS when the MES never answers the read', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      requestOf(input, init).path === SESSION_PATH
        ? new Promise<Response>(() => undefined)
        : Promise.resolve(json({})),
    );
    const started = Date.now();
    await renderApp('/login', { session: 'fetch', live: 'stopped' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SESSION_CHECK_MAX_MS - 500));
    });
    expect(screen.queryByTestId('login-username')).toBeNull();
    await screen.findByTestId('login-username', {}, { timeout: 2_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(SESSION_CHECK_MAX_MS - 50);
  });
});
