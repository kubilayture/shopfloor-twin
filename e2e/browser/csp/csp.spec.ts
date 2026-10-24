import { expect, test, type Browser, type Page } from '@playwright/test';
import { account, logIn, type Account } from '../login.ts';

/**
 * No Content-Security-Policy violation on any route (#338, audit G-24), under the web front's own
 * CSP (`apps/web/nginx/security-headers.conf`: `script-src 'self'`, no `'unsafe-eval'`). Before
 * #338 every page load reported one: Zod 4's probe for `new Function` when the contracts build
 * their first object schema (`apps/web/src/zod-config.ts` now sets `jitless` first).
 *
 * A listener registered before the app loads (`addInitScript`) reports each
 * `securitypolicyviolation` of every page and every navigation. Each page is loaded from the
 * server (`goto`, so the bundle runs again) as a role that may open it:
 * - signed out: the login and Line A1's terminal sign-on;
 * - the supervisor: every list and desk route (overview, OEE, downtime, alarms, alarm KPIs, orders,
 *   SPC, holds, trace, shift reports, terminal picker, account), and the first detail of the
 *   lists that always have one at dispatch time, asserted present: a machine (`/equipment/…`), an
 *   imported order (`/orders/…`) and an SPC characteristic (`/quality/spc/…`); the first hold and
 *   the first shift report only when the list shows one (at dispatch time it may be empty);
 * - the admin: the user admin and the simulation console;
 * - quality: a new hold.
 * Trace detail pages (serial, lot, carton) are not loaded. Lazy charts (ECharts, uPlot) are waited
 * for. Runs in the reconciliation's `orders-dispatch` project (the gate), before anything is
 * released; reads only. The details loaded are recorded as the test's `csp-details` annotation.
 */
const web = process.env.RECONCILE_WEB_URL ?? '';

interface Violation {
  readonly route: string;
  readonly directive: string;
  readonly blocked: string;
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly sample: string;
}

/** A fresh context whose pages report every CSP violation into `violations`, tagged by route. */
async function watchedPage(browser: Browser, violations: Violation[]) {
  const context = await browser.newContext();
  await context.exposeBinding('__reportCspViolation', ({ page }, raw: Omit<Violation, 'route'>) => {
    violations.push({ route: new URL(page.url()).pathname, ...raw });
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as Record<string, (v: unknown) => void>)
        .__reportCspViolation;
      report?.({
        directive: event.violatedDirective,
        blocked: event.blockedURI,
        source: event.sourceFile,
        line: event.lineNumber,
        column: event.columnNumber,
        sample: event.sample,
      });
    });
  });
  return { context, page: await context.newPage() };
}

/** Loads `path` from the server and waits until its lazy charts are in and the page is idle. */
async function load(page: Page, path: string, ready?: (page: Page) => Promise<void>) {
  await page.goto(path);
  await (ready ? ready(page) : expect(page.getByTestId('signed-in-user')).toBeVisible());
  await expect(page.getByText('Loading chart…')).toHaveCount(0, { timeout: 15_000 });
  // A violation is reported in a task of its own: let the queue drain before the next navigation.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 300))),
  );
}

/** A list's first detail: its link prefix, and whether the list always has one at dispatch time. */
interface Detail {
  readonly prefix: string;
  readonly required: boolean;
}

/**
 * The first link on the page into `detail.prefix` (`/new` excluded). A required one is waited for
 * and asserted; an optional one is taken if the list shows one within a few seconds.
 */
async function firstLink(page: Page, detail: Detail): Promise<string | undefined> {
  const link = page.locator(`main a[href^="${detail.prefix}"]:not([href$="/new"])`).first();
  if (detail.required) {
    await expect(link, `a link into ${detail.prefix}`).toBeVisible({ timeout: 15_000 });
  } else {
    const shown = await link.waitFor({ timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    if (!shown) return undefined;
  }
  return (await link.getAttribute('href')) ?? undefined;
}

/**
 * Logs `user` in on a watched page and loads each route, then its list's first detail; resolves
 * with the details loaded.
 */
async function visit(
  browser: Browser,
  violations: Violation[],
  user: Account | undefined,
  routes: readonly string[],
  details: Readonly<Record<string, Detail>> = {},
): Promise<string[]> {
  const { context, page } = await watchedPage(browser, violations);
  await (user ? logIn(page, user) : logIn(page));
  const loaded: string[] = [];
  for (const route of routes) {
    await load(page, route);
    const detail = details[route];
    const href = detail ? await firstLink(page, detail) : undefined;
    if (href) {
      await load(page, href);
      loaded.push(href);
    }
  }
  await context.close();
  return loaded;
}

test('no route reports a Content-Security-Policy violation', async ({ browser }) => {
  test.skip(web === '', 'runs inside pnpm test:reconcile, which starts the stack');
  test.setTimeout(240_000);
  const violations: Violation[] = [];

  // Signed out: the login (before any session) and a terminal's sign-on.
  const signedOut = await watchedPage(browser, violations);
  await load(signedOut.page, '/login', (p) => expect(p.getByTestId('login-submit')).toBeVisible());
  await load(signedOut.page, '/terminal/line-a1', (p) =>
    expect(p.getByTestId('terminal-sign-on')).toBeVisible(),
  );
  await signedOut.context.close();

  // The supervisor: every desk screen; a machine, an order and a characteristic always, a hold and
  // a shift report when there is one.
  const details = await visit(
    browser,
    violations,
    undefined,
    [
      '/',
      '/oee',
      '/downtime',
      '/alarms',
      '/alarms/kpi',
      '/orders',
      '/quality/spc',
      '/quality/holds',
      '/trace',
      '/shifts',
      '/terminal',
      '/account',
    ],
    {
      '/': { prefix: '/equipment/', required: true },
      '/orders': { prefix: '/orders/', required: true },
      '/quality/spc': { prefix: '/quality/spc/', required: true },
      '/quality/holds': { prefix: '/quality/holds/', required: false },
      '/shifts': { prefix: '/shifts/', required: false },
    },
  );
  test.info().annotations.push({ type: 'csp-details', description: details.join(', ') });
  // The admin: the user admin and the simulation console.
  await visit(browser, violations, account('admin'), ['/admin/users', '/console']);
  // Quality: a new hold.
  await visit(browser, violations, account('quality'), ['/quality/holds/new']);

  expect(violations).toEqual([]);
});
