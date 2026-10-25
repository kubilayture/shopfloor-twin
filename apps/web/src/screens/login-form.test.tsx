import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEW_PASSWORD, PASSWORD, fakeMes } from '../test/fake-mes.ts';
import { renderApp } from '../test/render-app.tsx';

/**
 * UX-11 (#335): the login and account pages on the design system. The fields are labelled, a
 * problem is shown under its field and tied to it (`aria-invalid`, `aria-describedby`, L-01), the
 * focus goes to the first field with one, the submit shows that it is busy, the account's times
 * are wall times by the content rules (Y-01), its permissions words by area (Y-02), and there is
 * one Log out (Y-03).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The texts a control is described by (`aria-describedby`), joined. */
function description(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `<missing ${id}>`)
    .join(' | ');
}

const field = (testId: string) => screen.getByTestId<HTMLInputElement>(testId);

/**
 * The fake MES with the writes matching `hang` never answered, counting every request: a busy
 * form must send no second one.
 */
function hanging(hang: (method: string, path: string) => boolean, options = {}) {
  const mes = fakeMes(options);
  const sent: string[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://x')
      .pathname;
    sent.push(`${method} ${path}`);
    return hang(method, path) ? new Promise<Response>(() => undefined) : mes.fetch(input, init);
  };
  return { fetch, count: (request: string) => sent.filter((one) => one === request).length };
}

/** Every way a form is sent again: a click on its submit, and Enter (the form's submit event). */
function sendAgain(submit: HTMLElement) {
  fireEvent.click(submit);
  const form = submit.closest('form');
  if (!form) throw new Error('the submit is in no form');
  fireEvent.submit(form);
  fireEvent.keyDown(form, { key: 'Enter' });
}

/** A fetch whose login answers 429 with a Retry-After; everything else as the fake MES. */
function throttled() {
  const mes = fakeMes();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (
      (init?.method ?? 'GET') === 'POST' &&
      (input instanceof Request ? input.url : input.toString()).endsWith('/api/v1/session')
    ) {
      return new Response(
        JSON.stringify({ type: 'about:blank', title: 'Too Many Requests', status: 429 }),
        {
          status: 429,
          headers: { 'content-type': 'application/problem+json', 'retry-after': '7' },
        },
      );
    }
    return mes.fetch(input, init);
  };
}

describe('the login page (UX-11)', () => {
  it('is a card with the product name, a heading and labelled fields', async () => {
    vi.stubGlobal('fetch', fakeMes().fetch);
    await renderApp('/login', { session: 'fetch' });
    const main = await screen.findByRole('main');
    expect(within(main).getByText('ShopFloor Twin')).toBeTruthy();
    expect(within(main).getByRole('heading', { level: 1, name: 'Log in' })).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Log in' });
    expect(within(form).getByLabelText('User name')).toBe(field('login-username'));
    expect(within(form).getByLabelText('Password')).toBe(field('login-password'));
    expect(field('login-password').type).toBe('password');
    expect(within(form).getByRole('button', { name: 'Log in' })).toBe(
      screen.getByTestId('login-submit'),
    );
    // The host-name note is small print, not a sentence in the form.
    expect(within(main).getByText(/the session belongs to the host name/)).toBeTruthy();
    expect(field('login-username').getAttribute('aria-invalid')).toBeNull();
  });

  it('marks an empty field under itself and focuses the first one', async () => {
    vi.stubGlobal('fetch', fakeMes().fetch);
    await renderApp('/login', { session: 'fetch' });
    fireEvent.click(await screen.findByTestId('login-submit'));
    expect((await screen.findByTestId('login-message')).textContent).toBe(
      'Enter your user name and password.',
    );
    expect(field('login-username').getAttribute('aria-invalid')).toBe('true');
    expect(field('login-password').getAttribute('aria-invalid')).toBe('true');
    expect(description(field('login-username'))).toBe('Enter your user name.');
    expect(description(field('login-password'))).toBe('Enter your password.');
    await waitFor(() => {
      expect(document.activeElement).toBe(field('login-username'));
    });

    // The alert says what is empty: only the name here.
    fireEvent.change(field('login-password'), { target: { value: 'something' } });
    fireEvent.click(screen.getByTestId('login-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('login-message').textContent).toBe('Enter your user name.');
    });
    expect(field('login-password').getAttribute('aria-invalid')).toBeNull();
    fireEvent.change(field('login-password'), { target: { value: '' } });

    // With the name given, only the password is marked, and it takes the focus.
    fireEvent.change(field('login-username'), { target: { value: 'ayse' } });
    fireEvent.click(screen.getByTestId('login-submit'));
    await waitFor(() => {
      expect(document.activeElement).toBe(field('login-password'));
    });
    expect(field('login-username').getAttribute('aria-invalid')).toBeNull();
    expect(field('login-username').getAttribute('aria-describedby')).toBeNull();
    expect(description(field('login-password'))).toBe('Enter your password.');
    expect(screen.getByTestId('login-message').textContent).toBe('Enter your password.');
  });

  it('ties a refused login to both fields, focuses the name and keeps what was typed', async () => {
    vi.stubGlobal('fetch', fakeMes().fetch);
    await renderApp('/login', { session: 'fetch' });
    fireEvent.change(await screen.findByTestId('login-username'), { target: { value: 'ayse' } });
    fireEvent.change(field('login-password'), { target: { value: 'wrong password, long' } });
    fireEvent.click(screen.getByTestId('login-submit'));
    const message = await screen.findByTestId('login-message');
    expect(message.getAttribute('role')).toBe('alert');
    for (const id of ['login-username', 'login-password']) {
      expect(field(id).getAttribute('aria-invalid')).toBe('true');
      expect(description(field(id))).toMatch(/user name or password is wrong/);
    }
    await waitFor(() => {
      expect(document.activeElement).toBe(field('login-username'));
    });
    expect(field('login-username').value).toBe('ayse');
    expect(field('login-password').value).toBe('wrong password, long');
  });

  it('says a throttled login without marking the fields: they are not what is wrong', async () => {
    vi.stubGlobal('fetch', throttled());
    await renderApp('/login', { session: 'fetch' });
    fireEvent.change(await screen.findByTestId('login-username'), { target: { value: 'ayse' } });
    fireEvent.change(field('login-password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByTestId('login-submit'));
    expect((await screen.findByTestId('login-message')).textContent).toMatch(
      /too many logins right now\. Try again in 7 s/,
    );
    expect(field('login-username').getAttribute('aria-invalid')).toBeNull();
    expect(field('login-password').getAttribute('aria-invalid')).toBeNull();
  });

  it('shows the submit busy while the login is on its way, keeping its name', async () => {
    const mes = fakeMes();
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'POST'
        ? new Promise<Response>(() => undefined)
        : mes.fetch(input, init),
    );
    await renderApp('/login', { session: 'fetch' });
    fireEvent.change(await screen.findByTestId('login-username'), { target: { value: 'ayse' } });
    fireEvent.change(field('login-password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByTestId('login-submit'));
    const submit = screen.getByTestId('login-submit');
    await waitFor(() => {
      expect(submit.getAttribute('aria-busy')).toBe('true');
    });
    expect(screen.getByRole('button', { name: 'Log in' })).toBe(submit);
  });

  it('sends no second login while one is on its way, by click or by Enter', async () => {
    const mes = hanging((method, path) => method === 'POST' && path === '/api/v1/session');
    vi.stubGlobal('fetch', mes.fetch);
    await renderApp('/login', { session: 'fetch' });
    fireEvent.change(await screen.findByTestId('login-username'), { target: { value: 'ayse' } });
    fireEvent.change(field('login-password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByTestId('login-submit'));
    await waitFor(() => {
      expect(mes.count('POST /api/v1/session')).toBe(1);
    });
    sendAgain(screen.getByTestId('login-submit'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mes.count('POST /api/v1/session')).toBe(1);
  });

  it('sends no login while a logout is still ending at the MES (#170 review L3)', async () => {
    const mes = hanging((method, path) => method === 'DELETE' && path === '/api/v1/session', {
      signedIn: true,
    });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/', { session: 'fetch' });
    await app.open();
    fireEvent.click(await screen.findByTestId('logout'));
    const submit = await screen.findByTestId('login-submit');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Logging out…' })).toBe(submit);
    });
    expect(submit.getAttribute('aria-busy')).toBe('true');
    fireEvent.change(field('login-username'), { target: { value: 'ayse' } });
    fireEvent.change(field('login-password'), { target: { value: PASSWORD } });
    sendAgain(submit);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mes.count('POST /api/v1/session')).toBe(0);
    expect(mes.count('DELETE /api/v1/session')).toBe(1);
  });

  it('marks only the password when the re-login cover is refused: the name is given', async () => {
    const mes = fakeMes({ signedIn: true, roles: ['admin'] });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/admin/users', { session: 'fetch' });
    await app.open();
    fireEvent.change(await screen.findByTestId('new-username'), { target: { value: 'half' } });
    mes.end();
    await app.drop(4401);
    await screen.findByTestId('relogin');
    fireEvent.change(field('login-password'), { target: { value: 'wrong password, long' } });
    fireEvent.click(screen.getByTestId('login-submit'));
    expect((await screen.findByTestId('login-message')).textContent).toMatch(
      /user name or password is wrong/,
    );
    expect(field('login-username').readOnly).toBe(true);
    expect(field('login-username').getAttribute('aria-invalid')).toBeNull();
    expect(field('login-username').getAttribute('aria-describedby')).toBeNull();
    expect(field('login-password').getAttribute('aria-invalid')).toBe('true');
    expect(description(field('login-password'))).toMatch(/user name or password is wrong/);
    await waitFor(() => {
      expect(document.activeElement).toBe(field('login-password'));
    });
  });
});

describe('the password forms (UX-11)', () => {
  it('shows the requirement before anything is typed and each problem under its field', async () => {
    const mes = fakeMes({ signedIn: true });
    vi.stubGlobal('fetch', mes.fetch);
    await renderApp('/account', { session: 'fetch' });
    const next = await screen.findByTestId<HTMLInputElement>('new-password');
    expect(screen.getByLabelText('New password')).toBe(next);
    expect(screen.getByLabelText('New password again')).toBe(field('confirm-password'));
    expect(screen.getByLabelText('Current password')).toBe(field('current-password'));
    expect(description(next)).toBe(
      '12 to 128 characters; a few words you remember are fine. No other rules.',
    );
    for (const id of ['current-password', 'new-password', 'confirm-password']) {
      expect(field(id).type).toBe('password');
    }

    fireEvent.change(next, { target: { value: 'short' } });
    fireEvent.click(screen.getByTestId('change-password'));
    const problems = await screen.findByTestId('password-problems');
    expect(problems.getAttribute('role')).toBe('alert');
    expect(problems.querySelectorAll('li')).toHaveLength(3);
    expect(field('current-password').getAttribute('aria-invalid')).toBe('true');
    expect(description(field('current-password'))).toBe('Enter your current password.');
    expect(next.getAttribute('aria-invalid')).toBe('true');
    expect(description(next)).toBe(
      '12 to 128 characters; a few words you remember are fine. No other rules. | The new password needs 12 to 128 characters (it has 5).',
    );
    expect(description(field('confirm-password'))).toBe('The two new passwords differ.');
    await waitFor(() => {
      expect(document.activeElement).toBe(field('current-password'));
    });

    // The current one given: the focus goes to the next field with a problem.
    fireEvent.change(field('current-password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByTestId('change-password'));
    await waitFor(() => {
      expect(document.activeElement).toBe(next);
    });
    expect(field('current-password').getAttribute('aria-invalid')).toBeNull();
    expect(mes.calls.some((c) => c.path === '/api/v1/account/password')).toBe(false);
  });

  it('sends no second password change while one is on its way, by click or by Enter', async () => {
    const mes = hanging(
      (method, path) => method === 'POST' && path === '/api/v1/account/password',
      {
        signedIn: true,
      },
    );
    vi.stubGlobal('fetch', mes.fetch);
    await renderApp('/account', { session: 'fetch' });
    fireEvent.change(await screen.findByTestId('current-password'), {
      target: { value: PASSWORD },
    });
    fireEvent.change(field('new-password'), { target: { value: NEW_PASSWORD } });
    fireEvent.change(field('confirm-password'), { target: { value: NEW_PASSWORD } });
    const submit = screen.getByTestId('change-password');
    fireEvent.click(submit);
    await waitFor(() => {
      expect(submit.getAttribute('aria-busy')).toBe('true');
    });
    expect(screen.getByRole('button', { name: 'Change password' })).toBe(submit);
    sendAgain(submit);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mes.count('POST /api/v1/account/password')).toBe(1);
  });

  it('marks only the confirmation when the two new passwords differ', async () => {
    vi.stubGlobal('fetch', fakeMes({ signedIn: true }).fetch);
    await renderApp('/account', { session: 'fetch' });
    fireEvent.change(await screen.findByTestId('current-password'), {
      target: { value: PASSWORD },
    });
    fireEvent.change(field('new-password'), { target: { value: NEW_PASSWORD } });
    fireEvent.change(field('confirm-password'), { target: { value: `${NEW_PASSWORD}x` } });
    fireEvent.click(screen.getByTestId('change-password'));
    expect((await screen.findByTestId('password-problems')).textContent).toBe(
      'The two new passwords differ.',
    );
    expect(field('new-password').getAttribute('aria-invalid')).toBeNull();
    expect(field('confirm-password').getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => {
      expect(document.activeElement).toBe(field('confirm-password'));
    });
  });

  it('puts the forced change on the login card, with a way out', async () => {
    vi.stubGlobal('fetch', fakeMes({ mustChange: true }).fetch);
    await renderApp('/login', { session: 'fetch' });
    fireEvent.change(await screen.findByTestId('login-username'), { target: { value: 'ayse' } });
    fireEvent.change(field('login-password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByTestId('login-submit'));
    const main = await screen.findByRole('main');
    expect(
      await within(main).findByRole('heading', { level: 1, name: 'Choose a new password' }),
    ).toBeTruthy();
    expect(within(main).getByText('ShopFloor Twin')).toBeTruthy();
    expect(screen.getByTestId('must-change').textContent).toBe(
      'ayse, your password is temporary. Choose your own before you continue; it ends your other sessions.',
    );
    const form = screen.getByRole('form', { name: 'Change password' });
    expect(screen.getByRole('button', { name: 'Log out instead' })).toBeTruthy();
    // The step is announced: its heading takes the focus from the login's submit.
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { level: 1, name: 'Choose a new password' }),
      );
    });
    // Whose password it is, for a password manager: hidden, read-only, not a field to fill.
    const user = within(form).getByTestId<HTMLInputElement>('password-username');
    expect([user.type, user.name, user.autocomplete, user.value]).toEqual([
      'text',
      'username',
      'username',
      'ayse',
    ]);
    expect([user.hidden, user.readOnly]).toEqual([true, true]);
  });
});

describe('the account page (UX-11)', () => {
  it('shows wall times by the content rules, permissions by area and no second Log out', async () => {
    vi.stubGlobal('fetch', fakeMes({ signedIn: true, roles: ['operator', 'quality'] }).fetch);
    await renderApp('/account', { session: 'fetch' });
    // After the session check, whose own `main` comes first.
    await screen.findByRole('heading', { level: 1, name: 'Account' });
    const main = screen.getByRole('main');
    expect(screen.getByTestId('account-username').textContent).toBe('ayse');

    // Both times say they are wall times, in the app's format (never the browser's locale).
    const times = within(main).getAllByText(/\(wall time\)$/);
    expect(times).toHaveLength(2);
    for (const time of times) {
      expect(time.tagName).toBe('TIME');
      // A time never breaks across lines ("(wall time)" alone on the next one).
      expect(time.className).toContain('whitespace-nowrap');
      expect(time.textContent).toMatch(
        /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}:\d{2} \(wall time\)$/,
      );
    }

    // Words by area, each with its id, in a disclosure closed by default.
    const permissions = screen.getByTestId('account-permissions');
    const details = permissions.closest('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe(
      'What your roles allow (11 permissions)',
    );
    const areas = within(permissions)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(areas).toEqual([
      'Plant data',
      'Downtime and scrap',
      'Alarms and shift notes',
      'Operator terminal',
      'Quality',
    ]);
    const scrap = within(permissions).getByText('Code scrap').closest('li');
    expect(scrap?.textContent).toBe('Code scrapscrap:code');

    // One Log out: the top bar's.
    expect(screen.getAllByRole('button', { name: /^Log out/ })).toHaveLength(1);
    expect(screen.getByTestId('logout')).toBeTruthy();
    expect(screen.queryByTestId('account-logout')).toBeNull();
  });
});
