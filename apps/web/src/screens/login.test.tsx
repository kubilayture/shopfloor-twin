import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionKey } from '../auth/auth.tsx';
import { NEW_PASSWORD, PASSWORD, fakeMes } from '../test/fake-mes.ts';
import { sessionOf } from '../test/fixtures.ts';
import { renderApp, settle } from '../test/render-app.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});

async function logIn(password = PASSWORD, username = 'ayse') {
  fireEvent.change(await screen.findByTestId('login-username'), { target: { value: username } });
  fireEvent.change(screen.getByTestId('login-password'), { target: { value: password } });
  fireEvent.click(screen.getByTestId('login-submit'));
}

describe('login (#170)', () => {
  it('sends a visitor without a session to /login and back to the page after logging in', async () => {
    const mes = fakeMes();
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/equipment/cnc-01?range=1h', { session: 'fetch' });
    await screen.findByRole('heading', { name: 'Log in' });
    expect(app.history.location.pathname).toBe('/login');
    expect(app.history.location.search).toContain('redirect=');

    await logIn();
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/equipment/cnc-01');
    });
    expect(app.history.location.search).toBe('?range=1h');
    const login = mes.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/session');
    expect(login?.body).toEqual({ username: 'ayse', password: PASSWORD, kind: 'desk' });
    expect(await screen.findByTestId('signed-in-user')).toHaveProperty('textContent', 'ayse');
  });

  it('says a failed login the same whatever failed, and keeps the user on the form', async () => {
    vi.stubGlobal('fetch', fakeMes().fetch);
    const app = await renderApp('/', { session: 'fetch' });
    await logIn('wrong password, long');
    expect((await screen.findByTestId('login-message')).textContent).toMatch(
      /user name or password is wrong, or the account is locked or disabled/,
    );
    expect(app.history.location.pathname).toBe('/login');
  });

  it('forces a temporary password to be changed before anything else', async () => {
    const mes = fakeMes({ mustChange: true });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/alarms', { session: 'fetch' });
    await logIn();
    expect((await screen.findByTestId('must-change')).textContent).toMatch(/temporary/);
    // The password just typed is the current one: not asked for again.
    expect(screen.queryByTestId('current-password')).toBeNull();
    fireEvent.change(screen.getByTestId('new-password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByTestId('confirm-password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByTestId('change-password'));
    expect((await screen.findByTestId('password-problems')).textContent).toMatch(/12 to 128/);
    fireEvent.change(screen.getByTestId('new-password'), { target: { value: NEW_PASSWORD } });
    fireEvent.change(screen.getByTestId('confirm-password'), { target: { value: NEW_PASSWORD } });
    fireEvent.click(screen.getByTestId('change-password'));
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/alarms');
    });
    const change = mes.calls.find((c) => c.path === '/api/v1/account/password');
    expect(change?.body).toEqual({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
  });

  it('goes to /login and back when a read answers 401, keeping the target', async () => {
    const mes = fakeMes({ signedIn: true });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    await screen.findByTestId('state-cnc-01');
    mes.end();
    await settle(() => {
      void app.queryClient.invalidateQueries({ queryKey: ['equipment'] });
    });
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/login');
    });
    expect(screen.getByTestId('login-reason').dataset.reason).toBe('ended');
    expect(app.live.status).toBe('stopped');
    await logIn();
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/');
    });
  });

  it('goes to /login when the socket closes with 4401, without reconnecting', async () => {
    vi.stubGlobal('fetch', fakeMes({ signedIn: true }).fetch);
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    await screen.findByTestId('state-cnc-01');
    const sockets = app.factory.sockets.length;
    await app.drop(4401);
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/login');
    });
    expect(app.live.status).toBe('stopped');
    expect(app.factory.sockets).toHaveLength(sockets);
  });

  it('keeps a page with unsaved input under a login for the same user (no draft lost)', async () => {
    const mes = fakeMes({ signedIn: true, roles: ['admin'] });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/admin/users', { session: 'fetch' });
    await app.open();
    const input = await screen.findByTestId('new-username');
    fireEvent.change(input, { target: { value: 'half-typed' } });
    mes.end();
    await app.drop(4401);
    const dialog = await screen.findByTestId('relogin');
    expect(dialog.textContent).toMatch(/kept/);
    expect(screen.getByTestId('app-page').dataset.locked).toBe('true');
    expect(app.history.location.pathname).toBe('/admin/users');
    expect(screen.getByTestId<HTMLInputElement>('login-username').readOnly).toBe(true);
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByTestId('login-submit'));
    await waitFor(() => {
      expect(screen.queryByTestId('relogin')).toBeNull();
    });
    expect(screen.getByTestId<HTMLInputElement>('new-username').value).toBe('half-typed');
    expect(app.live.status).not.toBe('stopped');
  });

  it('logs out: ends the session at the MES, empties the cache and stops the live client', async () => {
    const mes = fakeMes({ signedIn: true });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    await screen.findByTestId('state-cnc-01');
    fireEvent.click(screen.getByTestId('logout'));
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/login');
    });
    expect(mes.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/session')).toBe(true);
    expect(app.queryClient.getQueryData(['equipment'])).toBeUndefined();
    expect(app.queryClient.getQueryData(sessionKey)).toBeNull();
    expect(app.live.status).toBe('stopped');
    expect((await screen.findByTestId('login-reason')).dataset.reason).toBe('logout');
  });

  it('warns before the session ends and logs out at its end (idle timeout here)', async () => {
    const ending = {
      ...sessionOf(['supervisor']),
      expiresAt: new Date(Date.now() + 1_500).toISOString(),
    };
    const mes = fakeMes({ signedIn: true, session: () => ending });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/', { session: ending });
    await app.open();
    const warning = await screen.findByTestId('idle-warning');
    expect(warning.dataset.absolute).toBe('true');
    await waitFor(
      () => {
        expect(app.history.location.pathname).toBe('/login');
      },
      { timeout: 15_000 },
    );
    expect(screen.getByTestId('login-reason').dataset.reason).toBe('idle');
    expect(mes.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/session')).toBe(true);
  });
});

describe('roles in the app (#170)', () => {
  it('shows user administration only to an admin', async () => {
    vi.stubGlobal('fetch', fakeMes({ signedIn: true }).fetch);
    await renderApp('/admin/users', { session: 'fetch' });
    expect(await screen.findByTestId('users-forbidden')).toBeTruthy();
    expect(screen.queryByTestId('nav-users')).toBeNull();
  });

  it('lets an admin create a user with a generated temporary password, shown once', async () => {
    const mes = fakeMes({ signedIn: true, roles: ['admin'] });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/admin/users', { session: 'fetch' });
    expect(await screen.findByTestId('nav-users')).toBeTruthy();
    fireEvent.change(await screen.findByTestId('new-username'), { target: { value: 'can' } });
    fireEvent.click(screen.getByTestId('new-role-supervisor'));
    fireEvent.click(screen.getByTestId('create-user'));
    const shown = await screen.findByTestId('temporary-password-value');
    const create = mes.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/users');
    const body = create?.body as { username: string; roles: string[]; password: string };
    expect(body.username).toBe('can');
    expect(body.roles).toEqual(['operator', 'supervisor']);
    expect(body.password).toMatch(/^[A-Za-z2-9]{16}$/);
    expect(shown.textContent).toBe(body.password);
    expect(await screen.findByTestId('user-can')).toBeTruthy();
    // Hidden on request (#170 review L2); it also goes after two minutes or with the session.
    fireEvent.click(screen.getByTestId('hide-temporary-password'));
    expect(screen.queryByTestId('temporary-password')).toBeNull();
    // …and the mutation that set it forgets it (no variables with the password left).
    await waitFor(() => {
      const held = app.queryClient
        .getMutationCache()
        .getAll()
        .some((m) => JSON.stringify(m.state.variables ?? null).includes(body.password));
      expect(held).toBe(false);
    });
  });

  it('shows the account with roles and permissions and changes the password', async () => {
    const mes = fakeMes({ signedIn: true, roles: ['operator', 'quality'] });
    vi.stubGlobal('fetch', mes.fetch);
    await renderApp('/account', { session: 'fetch' });
    expect((await screen.findByTestId('account-roles')).textContent).toBe('Operator, Quality');
    expect(screen.getByTestId('account-permissions').textContent).toContain('scrap:code');
    fireEvent.change(screen.getByTestId('current-password'), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByTestId('new-password'), { target: { value: NEW_PASSWORD } });
    fireEvent.change(screen.getByTestId('confirm-password'), { target: { value: NEW_PASSWORD } });
    fireEvent.click(screen.getByTestId('change-password'));
    expect((await screen.findByTestId('password-changed')).textContent).toBe(
      'Password changed. 1 other session ended.',
    );
  });
});
