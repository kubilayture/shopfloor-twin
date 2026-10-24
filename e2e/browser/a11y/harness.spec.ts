import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  devices,
  test,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  duplicateTitles,
  entryKey,
  filterFromEnv,
  iosLockFinding,
  rolesOf,
  routeSelected,
  statesOf,
  summarize,
  widthsOf,
  zeroCounts,
  type A11yReport,
  type A11yRole,
  type Entry,
  type KeyboardSample,
  type OverlayCheck,
  type PageState,
  type Skipped,
  type TouchScrollCheck,
} from '../../src/a11y-report.ts';
import { account, logIn, type Account } from '../login.ts';
import {
  AXE_TAGS,
  checkDrawer,
  checkOverlays,
  frames,
  heightFor,
  measure,
  menuButton,
  sampleKeyboard,
  screenshot,
  scrollLockStyles,
  settle,
} from './probe.ts';
import { DISCOVERY, ROUTES, type RouteSpec } from './routes.ts';

/**
 * The visual and accessibility harness (UX-1g, #321), report-only. The reconciliation runs it
 * after its passes when `RECONCILE_A11Y=1` (src/reconcile.ts), on the last pass's stack: data from
 * the shift, one user per role. Every route (routes.ts) in its data-rich, empty and not-found
 * state, as each role, at 1440, 1280, 1024, 768 and 390 px: axe with the WCAG 2.2 A and AA rules,
 * a screenshot, the title and whether the page scrolls sideways. Then, once the supervisor's data
 * pages are in: each route's `document.title` distinct (G-05), Tab-order and focus-visibility
 * sampling at 1440 and 390 (G-33), the overlays the pages open and the nav drawer (containment,
 * `inert`, Escape, outside click), and touch scrolling behind the open drawer in Chromium's mobile
 * emulation and in WebKit's iPhone profile when WebKit is installed.
 *
 * Order, so a budget cut leaves the most useful part: the supervisor's data pages (and the signed
 * out ones), the checks above, the supervisor's empty and not-found pages, then the other roles'.
 * Past `A11Y_BUDGET_MS` (15 minutes) it stops and the report lists what it did not reach.
 *
 * Writes `report.json`, `summary.md` and `screens/` to `A11Y_RESULTS` (default e2e/results/a11y).
 * It never fails on a finding; it fails only when it cannot run (no stack, the supervisor's login).
 * Narrowed with `A11Y_ROUTES`, `A11Y_ROLES`, `A11Y_WIDTHS`, `A11Y_STATES` (src/a11y-report.ts);
 * `A11Y_IDS` (JSON) gives detail ids, the rest are found on the list pages.
 */
const web = process.env.RECONCILE_WEB_URL ?? '';
const BUDGET_MS = Number(process.env.A11Y_BUDGET_MS ?? 15 * 60_000);
const RESULTS = process.env.A11Y_RESULTS ?? join(import.meta.dirname, '../../results/a11y');
const SCREENS = 'screens';
/** Keyboard sampling widths: the desktop and the phone (the drawer layout). */
const KEYBOARD_WIDTHS = [1440, 390];
/** The drawer is checked below the `xl` breakpoint (1280 px). */
const DRAWER_WIDTHS = [1024, 390];

interface Item {
  readonly route: RouteSpec;
  readonly state: PageState;
  readonly role: A11yRole;
  readonly url: string;
}

/** An error's first line, for the report. */
const message = (error: unknown) =>
  error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);

const fileSafe = (text: string) => text.replace(/[^A-Za-z0-9_-]+/g, '-');

test('visual and accessibility harness (report-only)', async ({ browser }) => {
  test.skip(web === '', 'runs inside pnpm test:reconcile with RECONCILE_A11Y=1');
  test.setTimeout(BUDGET_MS + 10 * 60_000);
  const filter = filterFromEnv(process.env);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const overBudget = () => Date.now() - started > BUDGET_MS;
  await mkdir(join(RESULTS, SCREENS), { recursive: true });

  const entries: Entry[] = [];
  const skipped: Skipped[] = [];
  const notReached: Skipped[] = [];
  const keyboard: KeyboardSample[] = [];
  const overlays: OverlayCheck[] = [];
  const touchScroll: TouchScrollCheck[] = [];
  const titles: Record<string, string> = {};
  let axeVersion = '';
  let planned = 0;
  let stoppedByBudget = false;
  const widths = widthsOf(filter);
  const roles = rolesOf(filter);
  const states = statesOf(filter);
  const routes = ROUTES.filter((r) => routeSelected(filter, r.id, r.path));
  const shell = filter.routes.length === 0 || filter.routes.includes('shell');

  const write = async () => {
    const report: A11yReport = {
      version: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      budgetMs: BUDGET_MS,
      elapsedMs: Date.now() - started,
      stoppedByBudget,
      axe: { version: axeVersion, tags: AXE_TAGS },
      filter,
      coverage: {
        planned,
        measured: entries.filter((e) => e.error === undefined).length,
        failed: entries.filter((e) => e.error !== undefined).length,
        skipped,
        notReached,
      },
      entries,
      titles: { byRoute: titles, duplicates: duplicateTitles(titles) },
      keyboard,
      overlays,
      touchScroll,
    };
    await writeFile(join(RESULTS, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
    await writeFile(join(RESULTS, 'summary.md'), summarize(report));
  };

  // The run's users: the supervisor always (the run cannot go on without it), the others when the
  // reconciliation made them (the orders and quality passes).
  const accounts = new Map<A11yRole, Account | undefined>();
  for (const role of roles) {
    if (role === 'signed-out' || role === 'supervisor') accounts.set(role, undefined);
    else {
      try {
        accounts.set(role, account(role));
      } catch {
        skipped.push({ route: '*', state: 'data', role, reason: 'no account for this role' });
      }
    }
  }

  /** A context for `role`, logged in (not for `signed-out`), its page at 1440 px. */
  const session = async (role: A11yRole): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    if (role === 'supervisor') await logIn(page);
    else if (role !== 'signed-out') await logIn(page, accounts.get(role));
    return { context, page };
  };

  // The ids of the detail routes: A11Y_IDS first, then the first link of each list page.
  const ids: Record<string, string> = {
    ...(JSON.parse(process.env.A11Y_IDS ?? '{}') as Record<string, string>),
  };
  const supervisor = await session('supervisor');
  for (const d of DISCOVERY) {
    if (ids[d.id] !== undefined) continue;
    if (d.from.includes('$lot') && ids.lot === undefined) continue;
    const from = d.from.replace('$lot', encodeURIComponent(ids.lot ?? ''));
    try {
      await supervisor.page.goto(from);
      await settle(supervisor.page);
      const link = supervisor.page
        .locator(`main a[href^="${d.prefix}"]:not([href$="/new"])`)
        .first();
      const shown = await link.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false,
      );
      const href = shown ? await link.getAttribute('href') : null;
      if (href) ids[d.id] = decodeURIComponent(href.slice(d.prefix.length).split(/[?#]/)[0] ?? '');
    } catch {
      // Not found: the route's data state is skipped below, with the reason.
    }
  }

  /** The combinations of one tier, with the ones that need a missing id listed as skipped. */
  const tier = (tierRoles: readonly A11yRole[], tierStates: readonly PageState[]): Item[] => {
    const items: Item[] = [];
    for (const role of tierRoles) {
      if (!roles.includes(role)) continue;
      if (role !== 'signed-out' && role !== 'supervisor' && !accounts.get(role)) continue;
      for (const route of routes) {
        if (role === 'signed-out' ? !(route.signedOutOnly || route.signedOut) : route.signedOutOnly)
          continue;
        for (const state of tierStates) {
          if (!states.includes(state)) continue;
          const make = route.states[state];
          if (!make) continue;
          const url = make(ids);
          if (url === undefined) {
            skipped.push({ route: route.id, state, role, reason: 'no id for its data state' });
            continue;
          }
          items.push({ route, state, role, url });
        }
      }
    }
    return items;
  };
  const others: A11yRole[] = ['operator', 'quality', 'maintenance', 'admin'];
  const tiers = [
    tier(['supervisor', 'signed-out'], ['data']),
    tier(['supervisor', 'signed-out'], ['empty', 'not-found']),
    tier(others, ['data']),
    tier(others, ['empty', 'not-found']),
  ];
  planned = tiers.flat().length * widths.length;

  /** Loads one item and measures it at every width; errors are recorded, never thrown. */
  const visit = async (page: Page, item: Item) => {
    let ready: boolean;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(item.url);
      ready = await settle(page);
    } catch (error) {
      for (const width of widths) {
        entries.push({
          route: item.route.id,
          state: item.state,
          role: item.role,
          width,
          url: item.url,
          title: '',
          screenshot: null,
          ready: false,
          overflowX: false,
          counts: zeroCounts(),
          violations: [],
          error: message(error),
        });
      }
      return;
    }
    for (const width of widths) {
      const base = {
        route: item.route.id,
        state: item.state,
        role: item.role,
        width,
        url: item.url,
      };
      try {
        await page.setViewportSize({ width, height: heightFor(width) });
        await frames(page);
        const m = await measure(page);
        axeVersion ||= m.axeVersion;
        const shot = join(
          SCREENS,
          fileSafe(item.role),
          `${fileSafe(`${item.route.id}-${item.state}`)}-${String(width)}.jpg`,
        );
        await mkdir(join(RESULTS, SCREENS, fileSafe(item.role)), { recursive: true });
        await screenshot(page, join(RESULTS, shot), width);
        entries.push({
          ...base,
          title: m.title,
          screenshot: shot,
          ready,
          overflowX: m.overflowX,
          counts: m.counts,
          violations: m.violations,
        });
        if (item.role === 'supervisor' && item.state === 'data' && width === 1440) {
          titles[item.route.id] = m.title;
        }
      } catch (error) {
        entries.push({
          ...base,
          title: '',
          screenshot: null,
          ready,
          overflowX: false,
          counts: zeroCounts(),
          violations: [],
          error: message(error),
        });
      }
    }
  };

  /** Runs a tier, one context per role; past the budget the rest goes to `notReached`. */
  const runTier = async (items: readonly Item[]) => {
    const sessions = new Map<A11yRole, { context: BrowserContext; page: Page }>([
      ['supervisor', supervisor],
    ]);
    try {
      for (const item of items) {
        if (stoppedByBudget || overBudget()) {
          stoppedByBudget = true;
          notReached.push({
            route: item.route.id,
            state: item.state,
            role: item.role,
            reason: 'budget',
          });
          continue;
        }
        let s = sessions.get(item.role);
        if (!s) {
          try {
            s = await session(item.role);
          } catch (error) {
            skipped.push({
              route: '*',
              state: item.state,
              role: item.role,
              reason: `login failed: ${message(error)}`,
            });
            accounts.set(item.role, undefined);
            continue;
          }
          sessions.set(item.role, s);
        }
        await visit(s.page, item);
        await write();
      }
    } finally {
      for (const [role, s] of sessions) if (role !== 'supervisor') await s.context.close();
    }
  };

  const [first = [], second = [], third = [], fourth = []] = tiers;
  await runTier(first);

  // Keyboard sampling and the overlays each page opens, as the supervisor.
  const page = supervisor.page;
  for (const item of first.filter((i) => i.role === 'supervisor')) {
    for (const width of KEYBOARD_WIDTHS.filter((w) => widths.includes(w))) {
      if (overBudget()) break;
      try {
        await page.setViewportSize({ width, height: heightFor(width) });
        await page.goto(item.url);
        await settle(page);
        const k = await sampleKeyboard(page);
        keyboard.push({ route: item.route.id, role: 'supervisor', width, ...k });
        if (width === 1440) {
          await page.goto(item.url);
          await settle(page);
          overlays.push(...(await checkOverlays(page, item.route.id, width)));
        }
      } catch (error) {
        keyboard.push({
          route: item.route.id,
          role: 'supervisor',
          width,
          stops: [],
          longestTableRun: 0,
          findings: [`could not be sampled: ${message(error)}`],
        });
      }
    }
  }

  // The nav drawer at each drawer width, and touch scrolling behind it.
  if (shell && !overBudget()) {
    for (const width of DRAWER_WIDTHS.filter((w) => widths.includes(w))) {
      await page.setViewportSize({ width, height: heightFor(width) });
      await page.goto('/');
      await settle(page);
      overlays.push(await checkDrawer(page, 'overview', width));
    }
    touchScroll.push(await chromiumTouchScroll(browser));
    touchScroll.push(await webkitTouchScroll());
  }
  await write();

  await runTier(second);
  await runTier(third);
  await runTier(fourth);
  await supervisor.context.close();
  await write();
  test.info().annotations.push({
    type: 'a11y',
    description: `${String(entries.length)} pages, report in ${RESULTS}`,
  });
  // Every page measured is in the report; a page that failed to load is in it too (report-only).
  if (new Set(entries.map(entryKey)).size !== entries.length) {
    throw new Error('the report holds a page twice');
  }
});

/** A long page to scroll: the alarm history, else the orders. */
const LONG_PAGES = ['/alarms?view=history', '/orders', '/'];

async function longPage(page: Page): Promise<string | undefined> {
  for (const path of LONG_PAGES) {
    await page.goto(path);
    await settle(page);
    const long = await page.evaluate(
      () => document.documentElement.scrollHeight > window.innerHeight + 200,
    );
    if (long) return path;
  }
  return undefined;
}

/**
 * Chromium's phone emulation (390 × 844, touch): a real touch scroll gesture
 * (`Input.synthesizeScrollGesture`) on the backdrop and inside the nav while the drawer is open;
 * the page behind must not move.
 */
async function chromiumTouchScroll(browser: Browser): Promise<TouchScrollCheck> {
  const engine = 'Chromium, phone emulation';
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  try {
    const page = await context.newPage();
    await logIn(page);
    const route = await longPage(page);
    if (!route)
      return {
        engine,
        route: '-',
        ran: false,
        detail: {},
        findings: ['no page long enough to scroll'],
      };
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await menuButton(page).tap();
    await frames(page, 400);
    const cdp = await context.newCDPSession(page);
    const gesture = (x: number) =>
      cdp.send('Input.synthesizeScrollGesture', {
        x,
        y: 500,
        yDistance: -600,
        gestureSourceType: 'touch',
        speed: 1500,
      });
    await gesture(370);
    const afterBackdrop = await page.evaluate(() => window.scrollY);
    await gesture(120);
    const afterNav = await page.evaluate(() => window.scrollY);
    const styles = await scrollLockStyles(page);
    const findings: string[] = [];
    if (afterBackdrop > 0)
      findings.push(
        `a touch scroll on the backdrop scrolled the page by ${String(afterBackdrop)} px`,
      );
    if (afterNav > afterBackdrop)
      findings.push(
        `a touch scroll inside the nav scrolled the page behind by ${String(afterNav - afterBackdrop)} px`,
      );
    return { engine, route, ran: true, detail: { afterBackdrop, afterNav, ...styles }, findings };
  } catch (error) {
    return { engine, route: '-', ran: false, detail: {}, findings: [message(error)] };
  } finally {
    await context.close();
  }
}

/**
 * WebKit's iPhone profile, when WebKit is installed (`pnpm --filter @shopfloor/e2e exec playwright
 * install webkit`): the drawer opened by a tap, a wheel scroll over the backdrop, and the lock's
 * styles against the iOS rule of thumb (`iosLockFinding`). Playwright has no touch scroll gesture
 * for WebKit, so the rule of thumb carries the touch part.
 *
 * TLS: WebKit takes no SPKI pin and the stack's dev CA is not in the system's trust store; rather
 * than `ignoreHTTPSErrors` (never, playwright.config.ts), every request is routed through the
 * test runner, which trusts the dev CA (NODE_EXTRA_CA_CERTS). The live WebSocket is not routed, so
 * the page may show itself offline; the drawer does not depend on it.
 */
async function webkitTouchScroll(): Promise<TouchScrollCheck> {
  const engine = 'WebKit, iPhone 15 profile';
  let browser: Browser;
  try {
    browser = await webkit.launch();
  } catch {
    return {
      engine,
      route: '-',
      ran: false,
      detail: {},
      findings: [
        'WebKit is not installed (pnpm --filter @shopfloor/e2e exec playwright install webkit)',
      ],
    };
  }
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'], baseURL: web });
    await context.route('**/*', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    const page = await context.newPage();
    await logIn(page);
    const route = await longPage(page);
    if (!route)
      return {
        engine,
        route: '-',
        ran: false,
        detail: {},
        findings: ['no page long enough to scroll'],
      };
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await menuButton(page).tap();
    await frames(page, 400);
    let wheel = 'not supported';
    try {
      await page.mouse.move(370, 500);
      await page.mouse.wheel(0, 600);
      await frames(page, 300);
      wheel = String(await page.evaluate(() => window.scrollY));
    } catch {
      // Mobile WebKit has no wheel in Playwright: the styles below carry the check.
    }
    const styles = await scrollLockStyles(page);
    const findings = iosLockFinding(styles);
    if (wheel !== 'not supported' && Number(wheel) > 0)
      findings.push(`a wheel scroll over the backdrop scrolled the page by ${wheel} px`);
    return { engine, route, ran: true, detail: { wheelScrollY: wheel, ...styles }, findings };
  } catch (error) {
    return { engine, route: '-', ran: false, detail: {}, findings: [message(error)] };
  } finally {
    await browser.close();
  }
}
