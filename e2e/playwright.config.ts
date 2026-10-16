import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * The browser checks of the reconciliation (#100, #123). They run only inside `pnpm test:reconcile`,
 * which starts the stack and passes its addresses (RECONCILE_WEB_URL, RECONCILE_SIM_URL,
 * RECONCILE_MES_URL), one project at a time:
 * - `live`, during shift A: the overview's states and the OEE dashboard's values within 2 s;
 * - `final`, after the drain: a recode and a split through the downtime screen (browser/final).
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
