import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PASSWORD, fakeMes } from '../test/fake-mes.ts';
import { renderApp, settle } from '../test/render-app.tsx';
import { LOGOUT_PENDING_KEY, sessionKey } from './auth.tsx';
import { KEEPALIVE_MS } from './idle.ts';

// A logout and a read of the session racing at the MES (the demo's scene 8 flake): the read
// answered before the logout ended the session must not sign its user back in, and the late
// "session ended" that would follow must neither show nor wipe the login's typed name.

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

const requestOf = (input: RequestInfo | URL, init?: RequestInit) => ({
  method: init?.method ?? 'GET',
  path: new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost')
    .pathname,
});

let tabStorage = memoryStorage();
beforeEach(() => {
  tabStorage = memoryStorage();
  vi.stubGlobal('sessionStorage', tabStorage);
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a logout racing a read of the session', () => {
  it('ignores a session read the MES answered before the logout ended it (same page)', async () => {
    const mes = fakeMes({ signedIn: true });
    const late = gate();
    let holdNextRead = false;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const { method, path } = requestOf(input, init);
      if (holdNextRead && method === 'GET' && path === '/api/v1/session') {
        holdNextRead = false;
        // Answered by the MES now (the session still live), received only later.
        const answer = mes.fetch(input, init);
        return late.opened.then(() => answer);
      }
      return mes.fetch(input, init);
    });
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    await screen.findByTestId('signed-in-user');
    // A read of the session in flight (a 403's or a 4403's), answered as `ayse`.
    holdNextRead = true;
    await settle(() => {
      void app.queryClient.invalidateQueries({ queryKey: sessionKey });
    });
    fireEvent.click(screen.getByTestId('logout'));
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/login');
    });
    await settle(() => {
      late.open();
    });
    await settle(() => undefined);
    expect(app.queryClient.getQueryData(sessionKey)).toBeNull();
    expect(screen.queryByTestId('signed-in-user')).toBeNull();
    expect(app.history.location.pathname).toBe('/login');
    expect(screen.getByTestId('login-reason').dataset.reason).toBe('logout');
  });

  it("ignores the idle keepalive's read of the session when a logout came meanwhile", async () => {
    const mes = fakeMes({ signedIn: true });
    const late = gate();
    let holdNextRead = false;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const { method, path } = requestOf(input, init);
      if (holdNextRead && method === 'GET' && path === '/api/v1/session') {
        holdNextRead = false;
        const answer = mes.fetch(input, init);
        return late.opened.then(() => answer);
      }
      return mes.fetch(input, init);
    });
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    await screen.findByTestId('signed-in-user');
    const reads = mes.calls.filter((c) => c.method === 'GET' && c.path === '/api/v1/session');
    holdNextRead = true;
    // Input past the keepalive interval reads the session (`refresh`), answered as `ayse`.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + KEEPALIVE_MS + 1);
    await settle(() => {
      fireEvent.keyDown(window, { key: 'a' });
    });
    expect(mes.calls.filter((c) => c.method === 'GET' && c.path === '/api/v1/session').length).toBe(
      reads.length + 1,
    );
    fireEvent.click(screen.getByTestId('logout'));
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/login');
    });
    await settle(() => {
      late.open();
    });
    await settle(() => undefined);
    expect(app.queryClient.getQueryData(sessionKey)).toBeNull();
    expect(screen.queryByTestId('signed-in-user')).toBeNull();
    expect(screen.getByTestId('login-reason').dataset.reason).toBe('logout');
  });

  it('finishes a logout the page left before it ended, before reading the session (a reload)', async () => {
    const mes = fakeMes({ signedIn: true });
    const cutOff = gate();
    let firstDelete = true;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const { method, path } = requestOf(input, init);
      if (firstDelete && method === 'DELETE' && path === '/api/v1/session') {
        firstDelete = false;
        // The first page's logout reaches the MES only after the next page's reads.
        return cutOff.opened.then(() => mes.fetch(input, init));
      }
      if (method === 'DELETE') {
        // The next page's logout takes a while: its read must wait for it.
        return new Promise((resolve) => setTimeout(resolve, 20)).then(() => mes.fetch(input, init));
      }
      return mes.fetch(input, init);
    });
    const first = await renderApp('/', { session: 'fetch' });
    await first.open();
    await screen.findByTestId('signed-in-user');
    fireEvent.click(screen.getByTestId('logout'));
    await waitFor(() => {
      expect(first.history.location.pathname).toBe('/login');
    });
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).not.toBeNull();
    // The test goes to /login at once (`page.goto`): a new document, the logout still on its way.
    first.unmount();
    const callsBefore = mes.calls.length;
    const second = await renderApp('/login', { session: 'fetch', live: 'stopped' });
    const username = await screen.findByTestId<HTMLInputElement>('login-username');
    // The new page ended the session first, then read it: none.
    const order = mes.calls
      .slice(callsBefore)
      .filter((c) => c.path === '/api/v1/session')
      .map((c) => c.method);
    expect(order.slice(0, 2)).toEqual(['DELETE', 'GET']);
    expect(second.queryClient.getQueryData(sessionKey)).toBeNull();
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    fireEvent.change(username, { target: { value: 'demo-quality' } });
    // The cut-off logout lands now; nothing on this page was signed in, so nothing is "lost".
    await settle(() => {
      cutOff.open();
    });
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

  it('a logout that ended clears its mark; a login clears one left behind', async () => {
    const mes = fakeMes({ signedIn: true });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    await screen.findByTestId('signed-in-user');
    fireEvent.click(screen.getByTestId('logout'));
    await waitFor(() => {
      expect(screen.getByTestId('login-submit').textContent).toBe('Log in');
    });
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    // A mark left behind (say, a logout whose answer never came) goes with the next login.
    tabStorage.setItem(LOGOUT_PENDING_KEY, '1');
    fireEvent.change(screen.getByTestId('login-username'), { target: { value: 'ayse' } });
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByTestId('login-submit'));
    await screen.findByTestId('signed-in-user');
    expect(tabStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it('reads the session as usual when no logout is pending, and when the storage refuses', async () => {
    const mes = fakeMes({ signedIn: true });
    vi.stubGlobal('fetch', mes.fetch);
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    await renderApp('/', { session: 'fetch' });
    expect((await screen.findByTestId('signed-in-user')).textContent).toBe('ayse');
    expect(mes.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });
});

describe('the login while the session is read', () => {
  it('shows no form until the session is known, so nothing typed is dropped by a redirect', async () => {
    const mes = fakeMes({ signedIn: true });
    const late = gate();
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const { method, path } = requestOf(input, init);
      if (method === 'GET' && path === '/api/v1/session') {
        return late.opened.then(() => mes.fetch(input, init));
      }
      return mes.fetch(input, init);
    });
    const app = await renderApp('/login', { session: 'fetch', live: 'stopped' });
    expect(screen.queryByTestId('login-username')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Checking your session…');
    await act(async () => {
      late.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Signed in already: on to the page, never a form to type into first.
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/');
    });
  });

  it('shows the form once the read finds no session, or cannot reach the MES', async () => {
    vi.stubGlobal('fetch', fakeMes().fetch);
    await renderApp('/login', { session: 'fetch', live: 'stopped' });
    expect(await screen.findByTestId('login-username')).toBeTruthy();
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('unreachable')));
    await renderApp('/login', { session: 'fetch', live: 'stopped' });
    await waitFor(() => {
      expect(screen.getAllByTestId('login-username')).toHaveLength(2);
    });
  });
});
