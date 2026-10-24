import { expect, test, type Browser, type Page } from '@playwright/test';
import { account, logIn, type Account } from '../login.ts';

/**
 * No Content-Security-Policy violation on any route (#338, audit G-24), under the web front's own
 * CSP (`apps/web/nginx/security-headers.conf`: `script-src 'self'`, no `'unsafe-eval'`). Before
 * #338 every page load reported one: Zod 4's probe for `new Function` when the contracts build
 * their first object schema (`apps/web/src/zod-config.ts` now sets `jitless` first).
 *
 * A listener registered before the app loads (`addInitScript`) reports each
 * `securitypolicyviolation` of every page and every navigation; the test loads every route, each
 * from the server (`goto`, so the bundle runs again), as the role that may open it: the login and
 * the terminal sign-on signed out; the production, quality and trace screens and one detail of each
 * list as the supervisor; the user admin and the simulation console as the admin; a new hold as
 * quality. Lazy charts (ECharts, uPlot) are waited for. Runs in the reconciliation's
 * `orders-dispatch` project (the gate), before anything is released; reads only.
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

/** The first link on the page into `prefix` (a list's first detail), or none. */
async function firstLink(page: Page, prefix: string): Promise<string | undefined> {
  const hrefs = await page
    .locator(`a[href^="${prefix}"]`)
    .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
  return hrefs.find((href) => href.length > prefix.length && !href.endsWith('/new'));
}

/** Logs `user` in on a watched page and loads each route, then each list's first detail. */
async function visit(
  browser: Browser,
  violations: Violation[],
  user: Account | undefined,
  routes: readonly string[],
  details: Readonly<Record<string, string>> = {},
) {
  const { context, page } = await watchedPage(browser, violations);
  await (user ? logIn(page, user) : logIn(page));
  for (const route of routes) {
    await load(page, route);
    const prefix = details[route];
    const detail = prefix ? await firstLink(page, prefix) : undefined;
    if (detail) await load(page, detail);
  }
  await context.close();
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

  // The supervisor: every desk screen, and the first detail of each list.
  await visit(
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
      '/': '/equipment/',
      '/orders': '/orders/',
      '/quality/spc': '/quality/spc/',
      '/quality/holds': '/quality/holds/',
      '/shifts': '/shifts/',
    },
  );
  // The admin: the user admin and the simulation console.
  await visit(browser, violations, account('admin'), ['/admin/users', '/console']);
  // Quality: a new hold.
  await visit(browser, violations, account('quality'), ['/quality/holds/new']);

  expect(violations).toEqual([]);
});
