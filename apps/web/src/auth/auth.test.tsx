import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveKeys, type LiveAlarms } from '../live/live-cache.ts';
import { occurrence } from '../test/alarm-fixtures.ts';
import { PASSWORD, fakeMes } from '../test/fake-mes.ts';
import { sessionOf } from '../test/fixtures.ts';
import { renderApp, settle } from '../test/render-app.tsx';
import { forgetLegacyStorage, sessionKey } from './auth.tsx';
import { ACTIVITY_STORAGE_KEY, KEEPALIVE_MS } from './idle.ts';

// The review of PR #186 (#170): re-login over a kept draft, another user after a lost session,
// the idle timeout's keepalive and warning, and the legacy storage keys.

/** An in-memory `Storage` (this jsdom's `localStorage` may be missing). */
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

let storage = memoryStorage();
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function logIn(username = 'ayse') {
  fireEvent.change(await screen.findByTestId('login-username'), { target: { value: username } });
  fireEvent.change(screen.getByTestId('login-password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByTestId('login-submit'));
}

const sessionReads = (calls: readonly { method: string; path: string }[]) =>
  calls.filter((c) => c.method === 'GET' && c.path === '/api/v1/session').length;

describe('a lost session (#170 review M2, M4)', () => {
  it('drops the pushed alarm copies after a same-user re-login over a kept draft', async () => {
    const mes = fakeMes({ signedIn: true, roles: ['admin'] });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/admin/users', { session: 'fetch' });
    await app.open();
    fireEvent.change(await screen.findByTestId('new-username'), { target: { value: 'half' } });
    // A copy pushed before the session ended.
    await app.push({ type: 'alarm', event: 'raised', occurrence: occurrence(1) });
    const before = app.queryClient.getQueryData<LiveAlarms>(liveKeys.alarms);
    expect(Object.keys(before?.occurrences ?? {})).toHaveLength(1);
    mes.end();
    await app.drop(4401);
    await screen.findByTestId('relogin');
    // While the socket is stopped, the MES changes that alarm: the push is missed.
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByTestId('login-submit'));
    await waitFor(() => {
      expect(screen.queryByTestId('relogin')).toBeNull();
    });
    await app.open();
    // The stale copy is gone: the screens read the REST answers again.
    const after = app.queryClient.getQueryData<LiveAlarms>(liveKeys.alarms);
    expect(Object.keys(after?.occurrences ?? {})).toHaveLength(0);
    expect(screen.getByTestId<HTMLInputElement>('new-username').value).toBe('half');
  });

  it('discards the draft and the cache when someone else logs in instead', async () => {
    const mes = fakeMes({ signedIn: true, roles: ['admin'] });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/admin/users', { session: 'fetch' });
    await app.open();
    fireEvent.change(await screen.findByTestId('new-username'), { target: { value: 'half' } });
    await screen.findByTestId('user-list');
    expect(app.queryClient.getQueryData(['users'])).toBeDefined();
    mes.end();
    await app.drop(4401);
    fireEvent.click(await screen.findByTestId('relogin-other'));
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/login');
    });
    expect(app.history.location.search).toContain('redirect=');
    await waitFor(() => {
      expect(app.queryClient.getQueryData(['users'])).toBeUndefined();
    });
    expect(mes.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/session')).toBe(true);
    await logIn('bora');
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/admin/users');
    });
    expect(screen.getByTestId<HTMLInputElement>('new-username').value).toBe('');
    expect(screen.getByTestId('signed-in-user').textContent).toBe('bora');
  });

  it("empties A's cache when B logs in after A's session ended without a draft, not for A", async () => {
    const mes = fakeMes({ signedIn: true });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    await screen.findByTestId('state-cnc-01');
    app.queryClient.setQueryData(['sentinel'], 'of ayse');
    mes.end();
    await settle(() => {
      void app.queryClient.invalidateQueries({ queryKey: ['equipment'] });
    });
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/login');
    });
    // Nothing is emptied until someone logs in: the same user keeps the cache.
    expect(app.queryClient.getQueryData(['sentinel'])).toBe('of ayse');
    await logIn('bora');
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/');
    });
    expect(app.queryClient.getQueryData(['sentinel'])).toBeUndefined();
    expect(app.queryClient.getQueryData(sessionKey)).toMatchObject({ user: { username: 'bora' } });
  });

  it('keeps the cache when the same user logs in again', async () => {
    const mes = fakeMes({ signedIn: true });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    await screen.findByTestId('state-cnc-01');
    app.queryClient.setQueryData(['sentinel'], 'of ayse');
    mes.end();
    await app.drop(4401);
    await logIn('ayse');
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/');
    });
    expect(app.queryClient.getQueryData(['sentinel'])).toBe('of ayse');
  });
});

describe('the idle timeout (#170 review M3, M4)', () => {
  it("warns before the MES's own idle expiry, reads the session once, and stays on request", async () => {
    let idleExpiresAt = new Date(Date.now() + 90_000).toISOString();
    const mes = fakeMes({
      signedIn: true,
      session: () => ({ ...sessionOf(['supervisor']), idleExpiresAt }),
    });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    const warning = await screen.findByTestId('idle-warning');
    expect(warning.dataset.absolute).toBe('false');
    // The warning read the session once (no input meanwhile).
    await waitFor(() => {
      expect(sessionReads(mes.calls)).toBe(2);
    });
    // "Stay logged in" reads it again, whatever the throttle: the MES moves its expiry.
    idleExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
    fireEvent.click(screen.getByTestId('stay-signed-in'));
    await waitFor(() => {
      expect(screen.queryByTestId('idle-warning')).toBeNull();
    });
    expect(sessionReads(mes.calls)).toBe(3);
  });

  it('reads the session on input at most every 30 s, and on use in another tab', async () => {
    const mes = fakeMes({ signedIn: true });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    await screen.findByTestId('state-cnc-01');
    const reads = sessionReads(mes.calls);
    // Within the throttle: no read.
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.pointerDown(window);
    expect(sessionReads(mes.calls)).toBe(reads);
    // Past it: one read, then none until the next 30 s.
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start + KEEPALIVE_MS + 1);
    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => {
      expect(sessionReads(mes.calls)).toBe(reads + 1);
    });
    expect(storage.getItem(ACTIVITY_STORAGE_KEY)).toBe(String(start + KEEPALIVE_MS + 1));
    // Another tab of this app was used later: that is use too, and its keepalive moved the MES's
    // expiry, so this tab reads the session again.
    now.mockReturnValue(start + 2 * KEEPALIVE_MS + 2);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: ACTIVITY_STORAGE_KEY,
        newValue: String(start + 2 * KEEPALIVE_MS + 2),
      }),
    );
    await waitFor(() => {
      expect(sessionReads(mes.calls)).toBe(reads + 2);
    });
    // Another key of storage is not use.
    now.mockReturnValue(start + 3 * KEEPALIVE_MS + 3);
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: '1' }));
    expect(sessionReads(mes.calls)).toBe(reads + 2);
  });
});

describe('legacy storage (#170 review L7)', () => {
  it('removes the name the write screens kept before #170', () => {
    storage.setItem('shopfloor.codedBy', 'Ayşe');
    storage.setItem('shopfloor.lastActivity', '1');
    forgetLegacyStorage(() => storage);
    expect(storage.getItem('shopfloor.codedBy')).toBeNull();
    expect(storage.getItem('shopfloor.lastActivity')).toBe('1');
    // Storage that refuses is no error.
    forgetLegacyStorage(() => {
      throw new Error('blocked');
    });
  });
});

describe('a 4403 close (#341 review, UX-7 review M2)', () => {
  it('starts the live client again when the session read back is unchanged', async () => {
    const mes = fakeMes({ signedIn: true, roles: ['supervisor'] });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    expect(app.factory.sockets).toHaveLength(1);
    const reads = sessionReads(mes.calls);
    const before = app.queryClient.getQueryData(sessionKey);
    await app.drop(4403);
    await waitFor(() => {
      expect(app.factory.sockets).toHaveLength(2);
    });
    expect(sessionReads(mes.calls)).toBeGreaterThan(reads);
    // The same session, the same object: no screen's effect on the session could restart it.
    expect(app.queryClient.getQueryData(sessionKey)).toBe(before);
    await app.open();
    expect(screen.getByTestId('connection-status').dataset.status).toBe('open');
  });

  it('does not start it again when the session read back has ended', async () => {
    const mes = fakeMes({ signedIn: true, roles: ['supervisor'] });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    mes.end();
    await app.drop(4403);
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/login');
    });
    expect(app.factory.sockets).toHaveLength(1);
    expect(app.live.status).toBe('stopped');
  });
});
