import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * The browser checks of the reconciliation (#100, #123, #147). They run only inside
 * `pnpm test:reconcile`, which starts the stack and passes its addresses (RECONCILE_WEB_URL,
 * RECONCILE_SIM_URL, RECONCILE_MES_URL, RECONCILE_SHIFT, RECONCILE_ALARMS_UNTIL), one project at a
 * time, its files in alphabetical order:
 * - `live`, during shift A: the alarm list, flood banner and alarm KPI cards, the OEE dashboard's
 *   values and the overview's states, each within 2 s;
 * - `final`, after the drain (browser/final): alarm actions, a recode and a split through the
 *   downtime screen, and a handover note on the shift report.
 * Chromium only. On failure: a trace and a screenshot in e2e/results/playwright/<project>.
 */
const results = process.env.RECONCILE_RESULTS ?? join(import.meta.dirname, 'results');
const chromium = devices['Desktop Chrome'];

export default defineConfig({
  testDir: './browser',
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
      testIgnore: 'final/**',
      outputDir: join(results, 'playwright', 'live'),
      use: { ...chromium },
    },
    {
      name: 'final',
      testDir: './browser/final',
      outputDir: join(results, 'playwright', 'final'),
      use: { ...chromium },
    },
  ],
});
