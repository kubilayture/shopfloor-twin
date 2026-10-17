import { expect, type Page } from '@playwright/test';

/**
 * The run's user (#170): `pnpm test:reconcile` creates it through the bootstrap admin with a
 * generated password and passes both here (RECONCILE_USERNAME, RECONCILE_PASSWORD).
 */
export const reconcileUser = process.env.RECONCILE_USERNAME ?? '';
const reconcilePassword = process.env.RECONCILE_PASSWORD ?? '';

/**
 * Logs in through `/login` as the run's user and waits for the app to come back to `/`. Resolves
 * with the session cookie (`sft_session=…`) for the test's own API reads.
 */
export async function logIn(page: Page): Promise<string> {
  if (reconcileUser === '' || reconcilePassword === '') {
    throw new Error('RECONCILE_USERNAME and RECONCILE_PASSWORD are not set');
  }
  // The trace (kept on failure) must not hold the password (#170 review L5): its fill and the
  // login request are left out by ending the runner's trace chunk without saving it, and a new
  // chunk starts after the login. Without tracing both calls throw and nothing changes.
  const tracing = page.context().tracing;
  const paused = await tracing.stopChunk().then(
    () => true,
    () => false,
  );
  try {
    await page.goto('/login');
    await page.getByTestId('login-username').fill(reconcileUser);
    await page.getByTestId('login-password').fill(reconcilePassword);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('signed-in-user')).toHaveText(reconcileUser);
  } finally {
    if (paused) await tracing.startChunk({ title: 'after the login' });
  }
  const session = (await page.context().cookies()).find((c) => c.name === 'sft_session');
  if (!session) throw new Error('the login set no session cookie');
  // HttpOnly (no script reads it) and SameSite=Strict (ADR-0026).
  expect([session.httpOnly, session.sameSite]).toEqual([true, 'Strict']);
  return `sft_session=${session.value}`;
}
