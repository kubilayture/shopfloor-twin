/**
 * Playwright's global setup (#228): a Playwright run is a heavy command, so it holds the host-wide
 * heavy-suite lock (`@shopfloor/test-kit/heavy-lock`). Started by `pnpm test:reconcile`, it
 * inherits the reconciliation's lock (`SHOPFLOOR_HEAVY_LOCK`) and returns at once; started by hand
 * (`pnpm exec playwright test`), it waits for any other heavy run and releases the lock at the end.
 */
import { acquireHeavyLock } from '@shopfloor/test-kit/heavy-lock';

export default async function globalSetup(): Promise<() => void> {
  const lock = await acquireHeavyLock({ command: `playwright test in ${process.cwd()}` });
  Object.assign(process.env, lock.env);
  return () => {
    lock.release();
  };
}
