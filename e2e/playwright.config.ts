import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * The browser checks of the reconciliation (#100, #123, #147, #178). They run only inside
 * `pnpm test:reconcile`, which starts the stack and passes its addresses (RECONCILE_WEB_URL,
 * RECONCILE_SIM_URL, RECONCILE_MES_URL, RECONCILE_SHIFT, RECONCILE_ALARMS_UNTIL, the run's users),
 * one project at a time, its files in alphabetical order. The alarms-01 pass:
 * - `live`, during shift A: the alarm list, flood banner and alarm KPI cards, the OEE dashboard's
 *   values and the overview's states, each within 2 s;
 * - `final`, after the drain (browser/final): alarm actions, a recode and a split through the
 *   downtime screen, and a handover note on the shift report.
 * The orders-01 pass (#178, browser/orders):
 * - `orders-dispatch`, while the simulator waits idle at the start: login and role checks, then
 *   the supervisor's release and dispatch through the UI;
 * - `orders-live`, during shift A: the OEE dashboard and the alarm checks as above, then the Line
 *   A1 terminal (counts within 2 s, start, pause, resume);
 * - `orders-final`, after the drain: sign-off at both terminals, drafts, scrap coding, close.
 * The quality-01 pass (#204, browser/quality; its dispatch is `orders-dispatch`):
 * - `quality-live`, during shift A with the drift: every SPC episode on the SPC page and the Line
 *   A1 terminal within 2 s, an operator signed on to Line A1 throughout;
 * - `quality-final`, after the drain: a serial's trace page with its crew, holds from the drift's
 *   episode and a lot, the terminal's banners, the close refused while held and allowed after.
 * The console run (#237, `pnpm test:console`, src/console-pass.ts) has a project of its own,
 * `console` (browser/console): every `/sim/` refusal and every console action as admin.
 * Every run holds the host-wide heavy-suite lock (#228, src/playwright-lock.ts).
 * Chromium only. On failure: a trace and a screenshot in e2e/results/<pass>/playwright/<project>.
 */
const results = process.env.RECONCILE_RESULTS ?? join(import.meta.dirname, 'results');
const chromium = devices['Desktop Chrome'];

export default defineConfig({
  testDir: './browser',
  // The heavy-suite lock (#228): inherited from the reconciliation, else taken for this run.
  globalSetup: './src/playwright-lock.ts',
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    ...(process.env.RECONCILE_WEB_URL ? { baseURL: process.env.RECONCILE_WEB_URL } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'live',
      testIgnore: ['final/**', 'orders/**', 'quality/**', 'console/**'],
      outputDir: join(results, 'playwright', 'live'),
      use: { ...chromium },
    },
    {
      name: 'final',
      testDir: './browser/final',
      outputDir: join(results, 'playwright', 'final'),
      use: { ...chromium },
    },
    {
      name: 'orders-dispatch',
      testDir: './browser/orders/dispatch',
      outputDir: join(results, 'playwright', 'orders-dispatch'),
      use: { ...chromium },
    },
    {
      name: 'orders-live',
      testMatch: ['1-oee-live.spec.ts', '2-alarms-live.spec.ts', 'orders/live/*.spec.ts'],
      outputDir: join(results, 'playwright', 'orders-live'),
      use: { ...chromium },
    },
    {
      name: 'orders-final',
      testDir: './browser/orders/final',
      outputDir: join(results, 'playwright', 'orders-final'),
      use: { ...chromium },
    },
    {
      name: 'quality-live',
      testDir: './browser/quality/live',
      outputDir: join(results, 'playwright', 'quality-live'),
      use: { ...chromium },
    },
    {
      name: 'quality-final',
      testDir: './browser/quality/final',
      outputDir: join(results, 'playwright', 'quality-final'),
      use: { ...chromium },
    },
    {
      name: 'console',
      testDir: './browser/console',
      outputDir: join(results, 'playwright', 'console'),
      use: { ...chromium },
    },
  ],
});
