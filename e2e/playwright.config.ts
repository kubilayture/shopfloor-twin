import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { WEB_SPKI_ENV, chromiumSpkiArgument } from '@shopfloor/test-kit/tls';

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
 * - `orders-oee`, right after the drain (#233): each order completed in shift A on its detail
 *   and shift A's line OEE on the dashboard, read from the page once final;
 * - `orders-final`, after the drain: sign-off at both terminals, drafts, scrap coding, close.
 * The quality-01 pass (#204, browser/quality; its dispatch is `orders-dispatch`):
 * - `quality-live`, during shift A with the drift: every SPC episode on the SPC page and the Line
 *   A1 terminal within 2 s, an operator signed on to Line A1 throughout;
 * - `quality-final`, after the drain: a serial's trace page with its crew, holds from the drift's
 *   episode and a lot, the terminal's banners, the close refused while held and allowed after.
 * The console run (#237, `pnpm test:console`, src/console-pass.ts) has a project of its own,
 * `console` (browser/console): every `/sim/` refusal and every console action as admin, and
 * (#270) the effects of a lot block and a failure seen in the MES; then `console-shift`
 * (browser/console-shift), on a second simulator run started at 13:40: both ASM-01 operators of
 * shift B absent leave ASM-01 Idle NO-OPERATOR from its start.
 * The demo (#281, `pnpm demo`, src/demo.ts) has `demo` (browser/demo): the eight scenes of
 * docs/demo.md on one page, each asserting what it shows.
 * The resilience suite (#243, `pnpm test:resilience`, src/resilience.ts) has `resilience`
 * (browser/resilience): the overview open through a whole run, reconnecting and current after
 * every fault.
 * The HTTPS front (P9-14, ADR-0039, checklist S4; browser/tls) runs in `orders-dispatch` (the gate's
 * reconciliation, while the simulator waits) and in `console`.
 * No Content-Security-Policy violation on any route (#338; browser/csp) runs in `orders-dispatch`.
 * The visual and accessibility harness (UX-1g, #321; browser/a11y) has `a11y`: a failing gate since
 * UX-F1 (#337), run by the reconciliation after its passes when RECONCILE_A11Y=1 (e2e/results/a11y).
 * Every run holds the host-wide heavy-suite lock (#228, src/playwright-lock.ts).
 * Chromium for every project; `a11y` also launches WebKit's iPhone profile for its touch-scroll
 * check, which the gate requires (`pnpm --filter @shopfloor/e2e playwright:install:webkit`). On failure: a trace and a screenshot in e2e/results/<pass>/playwright/<project>.
 *
 * TLS (P9-14): the web front serves a certificate of the stack's own dev CA, which Chromium doesn't
 * trust. The harness passes the SPKI hash of that certificate (RECONCILE_WEB_SPKI, from the pki
 * step's volume, checked against the handshake: e2e/src/stack.ts `webTrust`), and Chromium is
 * launched with `--ignore-certificate-errors-spki-list` for that key alone. Never
 * `ignoreHTTPSErrors`: it would accept any certificate (browser/tls/tls.spec.ts proves another
 * one is refused). The test runner's own Node requests trust the CA through NODE_EXTRA_CA_CERTS.
 */
const results = process.env.RECONCILE_RESULTS ?? join(import.meta.dirname, 'results');
const spki = process.env[WEB_SPKI_ENV];
const chromium = {
  ...devices['Desktop Chrome'],
  ...(spki ? { launchOptions: { args: [chromiumSpkiArgument(spki)] } } : {}),
};

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
      testIgnore: [
        'final/**',
        'orders/**',
        'quality/**',
        'console/**',
        'console-shift/**',
        'tls/**',
        'csp/**',
        'resilience/**',
        'demo/**',
        'a11y/**',
      ],
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
      testMatch: ['orders/dispatch/*.spec.ts', 'tls/*.spec.ts', 'csp/*.spec.ts'],
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
      name: 'orders-oee',
      testDir: './browser/orders/oee',
      outputDir: join(results, 'playwright', 'orders-oee'),
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
      name: 'resilience',
      testDir: './browser/resilience',
      outputDir: join(results, 'playwright', 'resilience'),
      use: { ...chromium },
    },
    {
      name: 'console',
      testMatch: ['console/*.spec.ts', 'tls/*.spec.ts'],
      outputDir: join(results, 'playwright', 'console'),
      use: { ...chromium },
    },
    {
      name: 'demo',
      testDir: './browser/demo',
      outputDir: join(results, 'playwright', 'demo'),
      use: { ...chromium },
    },
    {
      // UX-1g (#321), gate since UX-F1 (#337): after the reconciliation's passes, RECONCILE_A11Y=1.
      name: 'a11y',
      testDir: './browser/a11y',
      outputDir: join(results, 'playwright', 'a11y'),
      use: { ...chromium },
    },
    {
      name: 'console-shift',
      testDir: './browser/console-shift',
      outputDir: join(results, 'playwright', 'console-shift'),
      use: { ...chromium },
    },
  ],
});
