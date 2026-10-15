import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * The live overview check of the reconciliation (#100). It runs only inside `pnpm test:reconcile`,
 * which starts the stack and passes its addresses (RECONCILE_WEB_URL, RECONCILE_SIM_URL).
 * Chromium only. On failure: a trace and a screenshot in e2e/results/playwright.
 */
const results = process.env.RECONCILE_RESULTS ?? join(import.meta.dirname, 'results');

export default defineConfig({
  testDir: './browser',
  outputDir: join(results, 'playwright'),
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    ...(process.env.RECONCILE_WEB_URL ? { baseURL: process.env.RECONCILE_WEB_URL } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
