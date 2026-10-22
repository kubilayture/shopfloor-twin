import { expect, type Page } from '@playwright/test';
import { SECURE_SESSION_COOKIE, SESSION_COOKIE } from '@shopfloor/contracts/identity';

/**
 * The run's user (#170): `pnpm test:reconcile` creates it through the bootstrap admin with a
 * generated password and passes both here (RECONCILE_USERNAME, RECONCILE_PASSWORD).
 */
export const reconcileUser = process.env.RECONCILE_USERNAME ?? '';
const reconcilePassword = process.env.RECONCILE_PASSWORD ?? '';

/** A generated user of the run (#178): name and password, never written to a file. */
export interface Account {
  readonly username: string;
  readonly password: string;
}

/**
 * The orders pass's other users (#178), by what they are for (`operator`, `operator2`, `admin`,
 * `quality`, `maintenance`): RECONCILE_ACCOUNTS, a JSON object the reconciliation passes with
 * generated passwords.
 */
export function account(name: string): Account {
  const accounts = JSON.parse(process.env.RECONCILE_ACCOUNTS ?? '{}') as Record<string, Account>;
  const found = accounts[name];
  if (!found) throw new Error(`RECONCILE_ACCOUNTS has no ${name}`);
  return found;
}

/**
 * Runs `fill` with the runner's trace paused (#170 review L5): the trace kept on failure must
 * not hold a password, so its fill and the login request are left out by ending the trace chunk
 * without saving it, and a new chunk starts afterwards. Without tracing both calls throw and
 * nothing changes.
 */
async function untraced(page: Page, fill: () => Promise<void>): Promise<void> {
  const tracing = page.context().tracing;
  const paused = await tracing.stopChunk().then(
    () => true,
    () => false,
  );
  try {
    await fill();
  } finally {
    if (paused) await tracing.startChunk({ title: 'after the login' });
  }
}

/**
 * The session cookie of the page's context, checked HttpOnly and SameSite=Strict (ADR-0026), and
 * over HTTPS (P9-14, ADR-0039) named `__Host-sft_session` and `Secure` (MES_COOKIE_SECURE=on, the
 * Compose default).
 */
async function sessionCookie(page: Page): Promise<string> {
  const session = (await page.context().cookies()).find(
    (c) => c.name === SECURE_SESSION_COOKIE || c.name === SESSION_COOKIE,
  );
  if (!session) throw new Error('the login set no session cookie');
  expect([session.httpOnly, session.sameSite]).toEqual([true, 'Strict']);
  if (page.url().startsWith('https:')) {
    expect([session.name, session.secure]).toEqual([SECURE_SESSION_COOKIE, true]);
  }
  return `${session.name}=${session.value}`;
}

/**
 * Logs in through `/login` as `user` (by default the run's user) and waits for the app to show
 * them signed in. Resolves with the session cookie (`__Host-sft_session=…` over HTTPS) for the test's own API calls.
 */
export async function logIn(
  page: Page,
  user: Account = { username: reconcileUser, password: reconcilePassword },
): Promise<string> {
  if (user.username === '' || user.password === '') {
    throw new Error('RECONCILE_USERNAME and RECONCILE_PASSWORD are not set');
  }
  await untraced(page, async () => {
    await page.goto('/login');
    // A password field (shown masked): the demo's recording (#282) shows every login.
    await expect(page.getByTestId('login-password')).toHaveAttribute('type', 'password');
    await page.getByTestId('login-username').fill(user.username);
    await page.getByTestId('login-password').fill(user.password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('signed-in-user')).toHaveText(user.username);
  });
  return sessionCookie(page);
}

/**
 * Signs `user` on at a work center's terminal (#177): `/terminal/<workCenter>`, user name and
 * password, a `terminal` session and the crew row. Resolves with the session cookie once the
 * screen shows them signed on.
 */
export async function signOnAtTerminal(
  page: Page,
  workCenter: string,
  user: Account,
): Promise<string> {
  await untraced(page, async () => {
    await page.goto(`/terminal/${workCenter}`);
    await expect(page.getByTestId('terminal-password')).toHaveAttribute('type', 'password');
    await page.getByTestId('terminal-username').fill(user.username);
    await page.getByTestId('terminal-password').fill(user.password);
    await page.getByTestId('terminal-sign-on').click();
    await expect(page.getByTestId('terminal-user')).toHaveText(user.username);
  });
  await expect(page.getByTestId('terminal-crew')).toContainText(user.username);
  return sessionCookie(page);
}
