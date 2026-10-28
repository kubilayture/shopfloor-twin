import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  devices,
  test,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
} from '@playwright/test';
import {
  budgetFromEnv,
  duplicateTitles,
  entryKey,
  filterFromEnv,
  gateVerdict,
  iosLockFinding,
  pagesPerItem,
  rolesOf,
  routeSelected,
  statesOf,
  summarize,
  themesOf,
  themeWidths,
  validateRoutes,
  widthsOf,
  SHELL,
  zeroCounts,
  type A11yReport,
  type A11yRole,
  type Entry,
  type KeyboardSample,
  type OverlayCheck,
  type PageState,
  type Skipped,
  type Theme,
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
 * The visual and accessibility harness (UX-1g, #321) and gate (UX-F1, #337). The reconciliation runs it
 * after its passes when `RECONCILE_A11Y=1` (src/reconcile.ts), on the last pass's stack: data from
 * the shift, one user per role. Every route (routes.ts) in its data-rich, empty and not-found
 * state, as each role, at 1440, 1280, 1024, 768 and 390 px in the light theme and at 1440 and
 * 390 px in the dark one (`DARK_WIDTHS`; the device setting emulated, UX-12's System choice):
 * axe with the WCAG 2.2 A and AA rules, a screenshot, the title and whether the page scrolls
 * sideways. Then, once the supervisor's data
 * pages are in: each route's `document.title` distinct (G-05), Tab-order and focus-visibility
 * sampling at 1440 and 390 (G-33), the overlays the pages open and the nav drawer (containment,
 * `inert`, Escape, outside click), and touch scrolling behind the open drawer in Chromium's mobile
 * emulation and in WebKit's iPhone profile when WebKit is installed.
 *
 * Order, so a budget cut leaves the most useful part: the supervisor's data pages (and the signed
 * out ones), the checks above, the supervisor's empty and not-found pages, then the other roles'.
 * Past `A11Y_BUDGET_MS` (40 minutes) it stops and the report lists what it did not reach.
 *
 * Writes `report.json`, `summary.md` and `screens/` to `A11Y_RESULTS` (default e2e/results/a11y),
 * then fails on the gate's verdict (`gateVerdict`): any critical or serious rule, any page not
 * measured (a budget cut is a failure, not a pass), a shared title, a failed overlay or drawer
 * check, touch scrolling behind the drawer not proven stopped, a write. Moderate and minor rules
 * are listed in `summary.md`. Narrowed with `A11Y_ROUTES`, `A11Y_ROLES`, `A11Y_WIDTHS`,
 * `A11Y_STATES`, `A11Y_THEMES` (src/a11y-report.ts); `A11Y_IDS` (JSON) gives detail ids, the rest
 * are found on the list pages.
 */
const web = process.env.RECONCILE_WEB_URL ?? '';
const RESULTS = process.env.A11Y_RESULTS
  ? resolve(process.env.INIT_CWD ?? process.cwd(), process.env.A11Y_RESULTS)
  : join(import.meta.dirname, '../../results/a11y');
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

/** Playwright's colour codes, which a report should not hold. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** An error's first line, for the report. */
const message = (error: unknown) =>
  (error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)).replace(ANSI, '');

const fileSafe = (text: string) => text.replace(/[^A-Za-z0-9_-]+/g, '-');

/**
 * Records every request other than GET and HEAD a context sends into `writes`, the login
 * (`POST /api/v1/session`) excepted: the harness must read only, so each is a finding.
 */
function watchWrites(context: BrowserContext, writes: string[]): void {
  context.on('request', (request: Request) => {
    const method = request.method();
    if (method === 'GET' || method === 'HEAD') return;
    const { pathname } = new URL(request.url());
    if (method === 'POST' && pathname === '/api/v1/session') return;
    writes.push(`${method} ${pathname}`);
  });
}

test('visual and accessibility harness (gate)', async ({ browser }) => {
  test.skip(web === '', 'runs inside pnpm test:reconcile with RECONCILE_A11Y=1');
  // A typo in a variable throws here: the run cannot check what it was asked to.
  const BUDGET_MS = budgetFromEnv(process.env);
  test.setTimeout(BUDGET_MS + 10 * 60_000);
  const filter = filterFromEnv(process.env);
  validateRoutes(filter, ROUTES);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const overBudget = () => Date.now() - started > BUDGET_MS;
  // A previous run's output in the same folder (a before/after pair kept apart) goes first.
  await rm(join(RESULTS, SCREENS), { recursive: true, force: true });
  await rm(join(RESULTS, 'report.json'), { force: true });
  await rm(join(RESULTS, 'summary.md'), { force: true });
  await mkdir(join(RESULTS, SCREENS), { recursive: true });

  const entries: Entry[] = [];
  const skipped: Skipped[] = [];
  const notReached: Skipped[] = [];
  const loginFailed: Skipped[] = [];
  let loginFailedPages = 0;
  const writes: string[] = [];
  const keyboard: KeyboardSample[] = [];
  const overlays: OverlayCheck[] = [];
  const touchScroll: TouchScrollCheck[] = [];
  const titles: Record<string, string> = {};
  let axeVersion = '';
  let planned = 0;
  let stoppedByBudget = false;
  const widths = widthsOf(filter);
  const themes = themesOf(filter);
  const perItem = pagesPerItem(filter);
  const roles = rolesOf(filter);
  const states = statesOf(filter);
  const routes = ROUTES.filter((r) => routeSelected(filter, r.id, r.path));
  const shell = filter.routes.length === 0 || filter.routes.includes(SHELL);

  /** Writes the report and summary as they stand, and returns the report. */
  const write = async (): Promise<A11yReport> => {
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
        notReachedPages: notReached.length * perItem,
        loginFailed,
        loginFailedPages,
      },
      entries,
      titles: { byRoute: titles, duplicates: duplicateTitles(titles) },
      keyboard,
      overlays,
      touchScroll,
      writes,
    };
    await writeFile(join(RESULTS, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
    await writeFile(join(RESULTS, 'summary.md'), summarize(report));
    return report;
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
    watchWrites(context, writes);
    try {
      const page = await context.newPage();
      if (role === 'supervisor') await logIn(page);
      else if (role !== 'signed-out') await logIn(page, accounts.get(role));
      return { context, page };
    } catch (error) {
      await context.close();
      throw error;
    }
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
  planned = tiers.flat().length * perItem;

  /**
   * Loads one item and measures it at each width of each theme: light first, then the dark theme
   * switched on the loaded page by the emulated device setting (UX-12's System choice follows it,
   * as it does for a user who changes the setting). A page whose theme did not apply is a failed
   * page, not a light one counted as dark. Errors are recorded, never thrown.
   */
  const visit = async (page: Page, item: Item) => {
    const base = (width: number, theme: Theme) => ({
      route: item.route.id,
      state: item.state,
      role: item.role,
      width,
      theme,
      url: item.url,
    });
    const failed = (width: number, theme: Theme, ready: boolean, error: unknown): Entry => ({
      ...base(width, theme),
      title: '',
      screenshot: null,
      ready,
      overflowX: false,
      counts: zeroCounts(),
      violations: [],
      error: message(error),
    });
    let ready: boolean;
    try {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(item.url);
      ready = await settle(page);
    } catch (error) {
      for (const theme of themes)
        for (const width of themeWidths(filter, theme))
          entries.push(failed(width, theme, false, error));
      return;
    }
    for (const theme of themes) {
      const themeWidthList = themeWidths(filter, theme);
      try {
        await useTheme(page, theme);
      } catch (error) {
        for (const width of themeWidthList) entries.push(failed(width, theme, ready, error));
        continue;
      }
      for (const width of themeWidthList) {
        try {
          await page.setViewportSize({ width, height: heightFor(width) });
          await frames(page);
          const m = await measure(page);
          axeVersion ||= m.axeVersion;
          // The light screenshots keep UX-1g's names, so before/after folders still line up.
          const suffix = theme === 'light' ? '' : `-${theme}`;
          const shot = join(
            SCREENS,
            fileSafe(item.role),
            `${fileSafe(`${item.route.id}-${item.state}`)}-${String(width)}${suffix}.jpg`,
          );
          await mkdir(join(RESULTS, SCREENS, fileSafe(item.role)), { recursive: true });
          await screenshot(page, join(RESULTS, shot), width);
          entries.push({
            ...base(width, theme),
            title: m.title,
            screenshot: shot,
            ready,
            overflowX: m.overflowX,
            counts: m.counts,
            violations: m.violations,
          });
          // Each route's title from the first page measured as the supervisor (signed out for
          // the login): its data state where it has one, as the tiers come in that order.
          if (
            theme === themes[0] &&
            width === themeWidthList[0] &&
            (item.role === 'supervisor' || item.role === 'signed-out')
          ) {
            titles[item.route.id] ??= m.title;
          }
        } catch (error) {
          entries.push(failed(width, theme, ready, error));
        }
      }
    }
  };

  const failedRoles = new Set<A11yRole>();
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
        // A role whose login failed once is not tried again: its pages count as lost to it.
        if (failedRoles.has(item.role)) {
          loginFailedPages += perItem;
          continue;
        }
        let s = sessions.get(item.role);
        if (!s) {
          try {
            s = await session(item.role);
          } catch (error) {
            failedRoles.add(item.role);
            loginFailed.push({
              route: '*',
              state: item.state,
              role: item.role,
              reason: `login failed: ${message(error)}`,
            });
            loginFailedPages += perItem;
            await write();
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

  // Keyboard sampling and the overlays each page opens, as the supervisor, in the light theme
  // (neither depends on colour). One the budget left is recorded as not taken: a gate failure.
  const page = supervisor.page;
  await page.emulateMedia({ colorScheme: 'light' });
  for (const item of first.filter((i) => i.role === 'supervisor')) {
    for (const width of KEYBOARD_WIDTHS.filter((w) => widths.includes(w))) {
      if (overBudget()) {
        stoppedByBudget = true;
        keyboard.push({
          route: item.route.id,
          role: 'supervisor',
          width,
          stops: [],
          longestTableRun: 0,
          findings: [],
          error: 'not reached within the budget',
        });
        continue;
      }
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
          findings: [],
          error: `could not be sampled: ${message(error)}`,
        });
      }
    }
  }

  // The nav drawer at each drawer width, and touch scrolling behind it. Left by the budget, each
  // is recorded as not run (a gate failure).
  if (shell && overBudget()) {
    stoppedByBudget = true;
    for (const engine of ['Chromium, phone emulation', 'WebKit, iPhone 15 profile']) {
      touchScroll.push({
        engine,
        route: '-',
        ran: false,
        detail: {},
        findings: ['not reached within the budget'],
      });
    }
  } else if (shell) {
    for (const width of DRAWER_WIDTHS.filter((w) => widths.includes(w))) {
      // A drawer that cannot be checked is a finding, never a failed run.
      try {
        await page.setViewportSize({ width, height: heightFor(width) });
        await page.goto('/');
        await settle(page);
        overlays.push(await checkDrawer(page, 'overview', width));
      } catch (error) {
        overlays.push({
          route: 'overview',
          width,
          kind: 'nav drawer',
          trigger: 'Menu',
          checks: {},
          findings: [`could not be checked: ${message(error)}`],
        });
      }
    }
    touchScroll.push(await chromiumTouchScroll(browser, writes));
    touchScroll.push(await webkitTouchScroll(writes));
  }
  await write();

  await runTier(second);
  await runTier(third);
  await runTier(fourth);
  await supervisor.context.close();
  const report = await write();
  test.info().annotations.push({
    type: 'a11y',
    description: `${String(entries.length)} pages, report in ${RESULTS}`,
  });
  if (new Set(entries.map(entryKey)).size !== entries.length) {
    throw new Error('the report holds a page twice');
  }
  // The gate (UX-F1): the report and summary are written first, so a red run has them.
  const { failures } = gateVerdict(report);
  if (failures.length > 0) {
    throw new Error(
      `the accessibility gate failed (${String(failures.length)}; ${join(RESULTS, 'summary.md')}):\n- ${failures.join('\n- ')}`,
    );
  }
});

/**
 * Applies a theme to the loaded page by the emulated device setting and waits until the app shows
 * it: `<html data-theme>` (UX-12) equal to it. A page without the attribute (an app from before
 * UX-12) counts as light only.
 */
async function useTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  const applied = await page
    .waitForFunction(
      (want) => (document.documentElement.dataset.theme ?? 'light') === want,
      theme,
      { timeout: 5_000 },
    )
    .then(
      () => true,
      () => false,
    );
  if (!applied) throw new Error(`the ${theme} theme did not apply (html data-theme)`);
  // Charts repaint in the new theme's colours.
  await frames(page, 300);
}

/** A long page to scroll: the alarm history, else the orders. */
const LONG_PAGES = ['/alarms?view=history', '/orders', '/'];
/** Where the page is scrolled to before the drawer opens: the lock must hold it there. */
const SCROLLED_TO = 300;

async function longPage(page: Page): Promise<string | undefined> {
  for (const path of LONG_PAGES) {
    await page.goto(path);
    await settle(page);
    const long = await page.evaluate(
      (by) => document.documentElement.scrollHeight > window.innerHeight + by + 200,
      SCROLLED_TO,
    );
    if (long) return path;
  }
  return undefined;
}

/** Where the page behind is drawn: `main`'s top edge in the viewport, and the scroll position. */
const position = (page: Page) =>
  page.evaluate(() => ({
    mainTop: Math.round(document.querySelector('main')?.getBoundingClientRect().top ?? 0),
    scrollY: Math.round(window.scrollY),
    // How far the viewport could still scroll: a touch scroll has nothing to move when it is 0.
    range: Math.max(
      0,
      Math.round(document.documentElement.scrollHeight - document.documentElement.clientHeight),
    ),
  }));

/**
 * The drawer's scroll lock, in any engine (UX-F1, #337): the page scrolled down `SCROLLED_TO`,
 * the drawer opened by a tap; `act` then tries to scroll the page behind (a touch gesture or a
 * wheel). The page must not move when the drawer opens or under `act`, must have nothing left to
 * scroll while it is open (iOS Safari scrolls a root with `overflow: hidden` under a finger, but
 * not a page with no scroll range), and must be back where it was once Escape closes it.
 */
async function lockProof(
  page: Page,
  act: () => Promise<Record<string, unknown>>,
): Promise<{ ran: boolean; detail: Record<string, unknown>; findings: string[] }> {
  await page.evaluate((y) => {
    window.scrollTo({ top: y, behavior: 'instant' });
  }, SCROLLED_TO);
  await frames(page);
  const before = await position(page);
  if (before.scrollY < SCROLLED_TO - 1) {
    return {
      ran: false,
      detail: { before },
      findings: [`the page did not scroll to ${String(SCROLLED_TO)} px before the drawer opened`],
    };
  }
  // A tap at the button's point: a locator's tap scrolls the button into view first, and with the
  // root's scroll padding that scrolls the page up under the sticky top bar.
  const box = await menuButton(page).boundingBox({ timeout: 3_000 });
  if (!box) return { ran: false, detail: { before }, findings: ['no menu button to tap'] };
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await frames(page, 400);
  const open = await position(page);
  const acted = await act();
  const after = await position(page);
  const styles = await scrollLockStyles(page);
  await page.keyboard.press('Escape');
  await frames(page, 400);
  const closed = await position(page);
  const findings: string[] = [];
  if (Math.abs(open.mainTop - before.mainTop) > 1)
    findings.push(
      `opening the drawer moved the page behind by ${String(open.mainTop - before.mainTop)} px`,
    );
  if (open.range > 0)
    findings.push(
      `with the drawer open the page can still scroll ${String(open.range)} px (a touch scroll moves it)`,
    );
  if (Math.abs(after.mainTop - open.mainTop) > 1 || after.scrollY !== open.scrollY)
    findings.push(
      `a scroll over the open drawer moved the page behind by ${String(open.mainTop - after.mainTop)} px`,
    );
  if (Math.abs(closed.scrollY - before.scrollY) > 1)
    findings.push(
      `closing the drawer left the page at ${String(closed.scrollY)} px, not ${String(before.scrollY)} px`,
    );
  return { ran: true, detail: { before, open, after, closed, ...acted, ...styles }, findings };
}

/**
 * Chromium's phone emulation (390 × 844, touch): real touch scroll gestures
 * (`Input.synthesizeScrollGesture`) on the backdrop and inside the nav while the drawer is open
 * (`lockProof`).
 */
async function chromiumTouchScroll(browser: Browser, writes: string[]): Promise<TouchScrollCheck> {
  const engine = 'Chromium, phone emulation';
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  watchWrites(context, writes);
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
    const cdp = await context.newCDPSession(page);
    const gesture = (x: number) =>
      cdp.send('Input.synthesizeScrollGesture', {
        x,
        y: 500,
        yDistance: -600,
        gestureSourceType: 'touch',
        speed: 1500,
      });
    const proof = await lockProof(page, async () => {
      await gesture(370);
      const afterBackdrop = await position(page);
      await gesture(120);
      return { afterBackdrop, gestures: 'backdrop at x 370, nav at x 120' };
    });
    return { engine, route, ...proof };
  } catch (error) {
    return { engine, route: '-', ran: false, detail: {}, findings: [message(error)] };
  } finally {
    await context.close();
  }
}

/**
 * WebKit's iPhone profile, when WebKit is installed (`pnpm --filter @shopfloor/e2e exec playwright
 * install webkit`): the drawer opened by a tap and `lockProof`, with a wheel scroll over the
 * backdrop where WebKit takes one. Playwright has no touch scroll gesture for WebKit, so the proof
 * that a finger cannot move the page is the scroll range (none left while open) with the page
 * held in place, and the lock's styles against the iOS rule of thumb (`iosLockFinding`).
 *
 * TLS: WebKit takes no SPKI pin and the stack's dev CA is not in the system's trust store; rather
 * than `ignoreHTTPSErrors` (never, playwright.config.ts), every request is routed through the
 * test runner, which trusts the stack's dev CA (NODE_EXTRA_CA_CERTS): a CA trust, weaker than
 * Chromium's pin to the one key, acceptable for a stack on 127.0.0.1. Only the stack's own origin
 * is fetched; any other request is aborted. The live WebSocket is not routed, so the page may show
 * itself offline; the drawer does not depend on it.
 */
async function webkitTouchScroll(writes: string[]): Promise<TouchScrollCheck> {
  const engine = 'WebKit, iPhone 15 profile';
  let browser: Browser;
  try {
    browser = await webkit.launch();
  } catch (error) {
    return {
      engine,
      route: '-',
      ran: false,
      detail: {},
      findings: [
        `WebKit did not launch (${message(error)}); to install it: pnpm --filter @shopfloor/e2e playwright:install:webkit`,
      ],
    };
  }
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'], baseURL: web });
    watchWrites(context, writes);
    const origin = new URL(web).origin;
    await context.route('**/*', async (route) => {
      const request = route.request();
      // The runner fetches for the stack's own origin only; it is no proxy to anywhere else.
      if (new URL(request.url()).origin !== origin) {
        await route.abort();
        return;
      }
      // WebKit leaves `Origin` out of an intercepted request's headers; the MES refuses a write
      // without it (ADR-0023), so the page's own origin goes back on, as the browser sends it.
      const write = !['GET', 'HEAD'].includes(request.method());
      const response = await route.fetch(
        write ? { headers: { ...request.headers(), origin } } : undefined,
      );
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
    const proof = await lockProof(page, async () => {
      try {
        await page.mouse.move(370, 500);
        await page.mouse.wheel(0, 600);
        await frames(page, 300);
        return { wheel: 'over the backdrop' };
      } catch {
        // Mobile WebKit has no wheel in Playwright: the range and position carry the check.
        return { wheel: 'not supported' };
      }
    });
    const styles = proof.detail as Record<string, string>;
    return {
      engine,
      route,
      ...proof,
      findings: [...proof.findings, ...(proof.ran ? iosLockFinding(styles) : [])],
    };
  } catch (error) {
    return { engine, route: '-', ran: false, detail: {}, findings: [message(error)] };
  } finally {
    await browser.close();
  }
}
