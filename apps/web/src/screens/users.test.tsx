import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { json, sessionOf } from '../test/fixtures.ts';
import { renderApp } from '../test/render-app.tsx';

// User administration on the design system (UX-10, #334): one table, the roles as checkboxes in
// one column, Disable and Reset password asked first in a ConfirmDialog (design system 4.9).

const ADMIN = sessionOf(['admin'], { username: 'root' });

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function fakeMes(options: { hold?: Promise<void>; refuse?: boolean } = {}) {
  const calls: Call[] = [];
  const at = '2026-10-20T08:00:00.000Z';
  const users = [
    { username: 'root', roles: ['admin'], enabled: true },
    { username: 'ana', roles: ['operator', 'quality'], enabled: true },
    { username: 'cem', roles: ['maintenance'], enabled: false },
  ].map((u, i) => ({
    id: i + 1,
    mustChangePassword: false,
    locked: false,
    createdAt: at,
    updatedAt: at,
    ...u,
  }));
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body: unknown =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, body });
    await Promise.resolve();
    if (url.pathname === '/api/v1/session') return json(ADMIN);
    if (url.pathname === '/api/v1/plant') return json({ site: null, clock: null, epochs: [] });
    if (url.pathname === '/api/v1/users') return json({ users });
    if (method !== 'GET' && options.hold) await options.hold;
    if (method !== 'GET' && options.refuse) {
      return json(
        { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'not allowed' },
        403,
      );
    }
    const match = /^\/api\/v1\/users\/([^/]+)(\/password)?$/.exec(url.pathname);
    const user = users.find((u) => u.username === match?.[1]);
    if (match && user) {
      if (match[2] === undefined) Object.assign(user, body);
      else user.mustChangePassword = true;
      return json(user);
    }
    return json({ type: 'about:blank', title: 'Not Found', status: 404 }, 404);
  };
  return { fetch, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function open(options: Parameters<typeof fakeMes>[0] = {}) {
  const mes = fakeMes(options);
  vi.stubGlobal('fetch', mes.fetch);
  await renderApp('/admin/users', { session: ADMIN });
  await screen.findByTestId('user-ana');
  return mes;
}

it('lists every user in one table, the roles as checkboxes in one named group', async () => {
  await open();
  const table = screen.getByRole('table', { name: 'All users' });
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent),
  ).toEqual(['User', 'Roles', 'Actions']);
  const row = screen.getByTestId('user-ana');
  expect(row.dataset.enabled).toBe('true');
  // The roles as words, once (the group's name), and as checkboxes.
  expect(screen.getByTestId('user-roles-ana').textContent).toBe('Operator, Quality');
  const group = within(row).getByRole('group', { name: 'Roles of ana, saved: Operator, Quality' });
  expect(
    within(group)
      .getAllByRole<HTMLInputElement>('checkbox')
      .filter((box) => box.checked)
      .map((box) => box.value),
  ).toEqual(['operator', 'quality']);
  expect(within(group).getByRole('checkbox', { name: 'Quality' }).getAttribute('name')).toBe(
    'ana-roles',
  );
  // Disabled users read Enable; the others Disable, a danger button (G-11).
  expect(screen.getByTestId('toggle-enabled-cem').textContent).toBe('Enable');
  expect(screen.getByTestId('toggle-enabled-ana').className).toMatch(/text-alarm-ink/);
  expect(screen.getByTestId('reset-password-ana').className).toMatch(/text-alarm-ink/);
  expect(screen.getByRole('button', { name: 'Reset password of ana' })).toBe(
    screen.getByTestId('reset-password-ana'),
  );
});

it('disables a user only once the dialog is confirmed; Cancel sends nothing', async () => {
  const mes = await open();
  fireEvent.click(screen.getByTestId('toggle-enabled-ana'));
  const dialog = screen.getByTestId('confirm-disable');
  expect(within(dialog).getByRole('heading').textContent).toBe('Disable user ana?');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => {
    expect(screen.getByTestId<HTMLDialogElement>('confirm-disable').open).toBe(false);
  });
  expect(mes.writes()).toEqual([]);

  fireEvent.click(screen.getByTestId('toggle-enabled-ana'));
  fireEvent.click(
    within(screen.getByTestId('confirm-disable')).getByRole('button', { name: 'Disable user' }),
  );
  expect((await screen.findByTestId('user-message-ana')).textContent).toBe(
    'ana is disabled; their sessions ended.',
  );
  expect(mes.writes()).toEqual([
    { method: 'PUT', path: '/api/v1/users/ana', body: { enabled: false } },
  ]);
  await waitFor(() => {
    expect(screen.getByTestId('toggle-enabled-ana').textContent).toBe('Enable');
  });
});

it('enables a user at once: it can be undone, so it does not ask', async () => {
  const mes = await open();
  fireEvent.click(screen.getByTestId('toggle-enabled-cem'));
  expect((await screen.findByTestId('user-message-cem')).textContent).toBe('cem may log in again.');
  expect(screen.getByTestId<HTMLDialogElement>('confirm-disable').open).toBe(false);
  expect(mes.writes()).toEqual([
    { method: 'PUT', path: '/api/v1/users/cem', body: { enabled: true } },
  ]);
});

it('resets a password after the dialog and shows the temporary one once', async () => {
  const mes = await open();
  fireEvent.click(screen.getByTestId('reset-password-ana'));
  const dialog = screen.getByTestId('confirm-reset');
  expect(within(dialog).getByRole('heading').textContent).toBe('Reset the password of ana?');
  expect(mes.writes()).toEqual([]);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reset password' }));
  const shown = await screen.findByTestId('temporary-password-value');
  const [write] = mes.writes();
  expect(write?.path).toBe('/api/v1/users/ana/password');
  expect(shown.textContent).toBe((write?.body as { password: string }).password);
  fireEvent.click(screen.getByTestId('hide-temporary-password'));
  expect(screen.queryByTestId('temporary-password')).toBeNull();
});

it('saves changed roles; Save roles is primary only while they differ', async () => {
  const mes = await open();
  const save = screen.getByTestId<HTMLButtonElement>('save-roles-ana');
  expect(save.disabled).toBe(true);
  fireEvent.click(screen.getByTestId('ana-role-supervisor'));
  expect(save.disabled).toBe(false);
  expect(save.className).toMatch(/bg-accent/);
  fireEvent.click(save);
  expect((await screen.findByTestId('user-message-ana')).textContent).toBe(
    'Roles of ana: Operator, Quality, Supervisor.',
  );
  expect(mes.writes()).toEqual([
    {
      method: 'PUT',
      path: '/api/v1/users/ana',
      body: { roles: ['operator', 'quality', 'supervisor'] },
    },
  ]);
});

it('marks a user name the MES would refuse on its field, and sends nothing', async () => {
  const mes = await open();
  fireEvent.change(screen.getByTestId('new-username'), { target: { value: 'Not Valid' } });
  fireEvent.click(screen.getByTestId('create-user'));
  const field = screen.getByTestId('new-username');
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByTestId('create-message').dataset.kind).toBe('invalid');
  fireEvent.click(screen.getByTestId('new-role-operator'));
  fireEvent.change(field, { target: { value: 'valid-name' } });
  fireEvent.click(screen.getByTestId('create-user'));
  expect(
    screen.getByRole('group', { name: 'Roles' }).getAttribute('aria-describedby'),
  ).toBeTruthy();
  expect(mes.writes()).toEqual([]);
});

it('keeps the dialog busy until the write settles, and shows a refusal inside it', async () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await open({ hold, refuse: true });
  fireEvent.click(screen.getByTestId('toggle-enabled-ana'));
  const dialog = screen.getByTestId<HTMLDialogElement>('confirm-disable');
  const confirm = within(dialog).getByRole('button', { name: 'Disable user' });
  fireEvent.click(confirm);
  await waitFor(() => {
    expect(confirm.getAttribute('aria-busy')).toBe('true');
  });
  expect(dialog.open).toBe(true);
  release();
  const refusal = await within(dialog).findByTestId('confirm-disable-refusal');
  expect(refusal.getAttribute('role')).toBe('alert');
  expect(refusal.textContent).toMatch(/Not saved/);
  expect(dialog.open).toBe(true);
  expect(confirm.getAttribute('aria-busy')).toBeNull();
  // One announcement: the line behind the dialog stays quiet while the dialog says it.
  expect(screen.getByTestId('user-message-ana').getAttribute('role')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => {
    expect(dialog.open).toBe(false);
  });
  expect(screen.getByTestId('user-message-ana').getAttribute('role')).toBe('alert');
  expect(screen.getByTestId('toggle-enabled-ana').textContent).toBe('Disable');
});
