import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../browser/a11y/routes.ts';
import {
  diffMarkdown,
  diffReports,
  duplicateTitles,
  filterFromEnv,
  fromAxe,
  gateVerdict,
  iosLockFinding,
  longestTableRun,
  pagesPerItem,
  tableRuns,
  themeWidths,
  themesOf,
  DEFAULT_BUDGET_MS,
  TOUCH_ENGINES,
  a11yOutcome,
  a11yPreflight,
  narrowedBy,
  skipTableOf,
  routeSelected,
  validateRoutes,
  budgetFromEnv,
  entryKey,
  summarize,
  zeroCounts,
  type A11yReport,
  type Entry,
  type KeyboardSample,
  type OverlayCheck,
  type TouchScrollCheck,
} from './a11y-report.ts';
import { REPO } from './stack.ts';

const entry = (over: Partial<Entry> = {}): Entry => ({
  route: 'orders',
  state: 'data',
  role: 'supervisor',
  width: 1440,
  url: '/orders',
  title: 'Production orders · ShopFloor Twin',
  screenshot: 'screens/supervisor/orders-data-1440.jpg',
  ready: true,
  overflowX: false,
  counts: zeroCounts(),
  violations: [],
  ...over,
});

const violation = (id: string, impact: 'critical' | 'serious' | 'moderate' | 'minor') => ({
  id,
  impact,
  help: `${id} help`,
  nodes: 1,
  targets: ['#x'],
});

const report = (entries: Entry[], over: Partial<A11yReport> = {}): A11yReport => ({
  version: 1,
  startedAt: '2026-10-24T00:00:00.000Z',
  finishedAt: '2026-10-24T00:10:00.000Z',
  budgetMs: 900_000,
  elapsedMs: 600_000,
  stoppedByBudget: false,
  axe: { version: '4.14.0', tags: ['wcag2a'] },
  filter: { routes: [], roles: [], widths: [], states: [] },
  coverage: {
    planned: entries.length,
    measured: entries.length,
    failed: 0,
    skipped: [],
    notReached: [],
    notReachedPages: 0,
    loginFailed: [],
    loginFailedPages: 0,
  },
  entries,
  titles: { byRoute: {}, duplicates: [] },
  keyboard: [],
  overlays: [],
  overlayScans: [],
  touchScroll: [],
  writes: [],
  ...over,
});

/** A keyboard sample with nothing found. */
const sample = (
  route: string,
  width: number,
  over: Partial<KeyboardSample> = {},
): KeyboardSample => ({
  route,
  role: 'supervisor',
  width,
  stops: [],
  longestTableRun: 0,
  skippedByLinkRun: 0,
  hidden: [],
  offScreen: [],
  covered: [],
  findings: [],
  ...over,
});
/** The nav drawer's check at a width, passed. */
const drawer = (width: number): OverlayCheck => ({
  route: 'overview',
  width,
  kind: 'nav drawer',
  trigger: 'Menu',
  checks: { opens: true },
  findings: [],
});
/** A touch-scroll check that ran clean. */
const ran = (engine: string): TouchScrollCheck => ({
  engine,
  route: '/orders',
  ran: true,
  detail: {},
  findings: [],
});
/**
 * An unfiltered run that passes: measured in full, no serious rule, and every check its plan
 * includes (the supervisor's orders data page: keyboard at 1440 and 390, overlays at 1440; the
 * drawer at 1024 and 390; touch scrolling in both engines).
 */
const green = (over: Partial<A11yReport> = {}, entries = [entry(), entry({ width: 390 })]) =>
  report(entries, {
    keyboard: [sample('orders', 1440), sample('orders', 390)],
    overlayScans: [{ route: 'orders', width: 1440 }],
    overlays: [drawer(1024), drawer(390)],
    touchScroll: TOUCH_ENGINES.map(ran),
    ...over,
  });

describe('filterFromEnv', () => {
  it('reads comma lists and leaves absent ones empty (all)', () => {
    expect(
      filterFromEnv({
        A11Y_ROUTES: 'orders, /quality',
        A11Y_ROLES: 'operator',
        A11Y_WIDTHS: '390,1440',
      }),
    ).toEqual({
      routes: ['orders', '/quality'],
      roles: ['operator'],
      widths: [390, 1440],
      states: [],
      themes: [],
    });
    expect(filterFromEnv({})).toEqual({
      routes: [],
      roles: [],
      widths: [],
      states: [],
      themes: [],
    });
    expect(
      filterFromEnv({
        A11Y_WIDTHS: '1440,1440,390',
        A11Y_ROUTES: 'orders,orders',
        A11Y_THEMES: 'dark, dark',
      }),
    ).toEqual({
      routes: ['orders'],
      roles: [],
      widths: [1440, 390],
      states: [],
      themes: ['dark'],
    });
  });

  it('refuses an unknown role, width or state rather than checking nothing', () => {
    expect(() => filterFromEnv({ A11Y_ROLES: 'supervisorr' })).toThrow(/unknown role/);
    expect(() => filterFromEnv({ A11Y_WIDTHS: 'wide' })).toThrow(/not a width/);
    expect(() => filterFromEnv({ A11Y_WIDTHS: '200' })).toThrow(/not a width/);
    expect(() => filterFromEnv({ A11Y_STATES: 'loading' })).toThrow(/unknown state/);
    expect(() => filterFromEnv({ A11Y_THEMES: 'light,dim' })).toThrow(/unknown theme dim/);
  });
});

describe('the time plan', () => {
  const none = { routes: [], roles: [], widths: [], states: [] };

  it('is light at five widths and dark at 1440 and 390: seven pages a combination', () => {
    expect(themesOf(none)).toEqual(['light', 'dark']);
    expect(themesOf({ ...none, themes: [] })).toEqual(['light', 'dark']);
    expect(themeWidths(none, 'light')).toEqual([1440, 1280, 1024, 768, 390]);
    expect(themeWidths(none, 'dark')).toEqual([1440, 390]);
    expect(pagesPerItem(none)).toBe(7);
  });

  it('narrows by A11Y_THEMES, and A11Y_WIDTHS sets the widths of both themes', () => {
    expect(pagesPerItem({ ...none, themes: ['light'] })).toBe(5);
    expect(pagesPerItem({ ...none, themes: ['dark'] })).toBe(2);
    const five = { ...none, widths: [1440, 1280, 1024, 768, 390], themes: ['dark' as const] };
    expect(themeWidths(five, 'dark')).toEqual([1440, 1280, 1024, 768, 390]);
    expect(pagesPerItem({ ...none, widths: [768] })).toBe(2);
  });
});

describe('validateRoutes', () => {
  const routes = [
    { id: 'orders', path: '/orders' },
    { id: 'order', path: '/orders/$id' },
    { id: 'overview', path: '/' },
  ];
  const filter = (r: string[]) => ({ routes: r, roles: [], widths: [], states: [] });

  it('accepts shell, route ids and path prefixes that select a route', () => {
    expect(() => {
      validateRoutes(filter(['shell', 'order', '/orders', '/']), routes);
    }).not.toThrow();
    expect(() => {
      validateRoutes(filter([]), routes);
    }).not.toThrow();
  });

  it('names every entry that is none of them, in a mixed list too', () => {
    expect(() => {
      validateRoutes(filter(['orders', 'ordrs', '/ordr', '/trace']), routes);
    }).toThrow(/no route ordrs, \/ordr, \/trace /);
    expect(() => {
      validateRoutes(filter(['Shell']), routes);
    }).toThrow(/no route Shell /);
  });
});

describe('budgetFromEnv', () => {
  it("is the time plan's budget by default and refuses anything but a positive whole number", () => {
    expect(DEFAULT_BUDGET_MS).toBe(40 * 60_000);
    expect(budgetFromEnv({})).toBe(DEFAULT_BUDGET_MS);
    expect(budgetFromEnv({ A11Y_BUDGET_MS: '' })).toBe(DEFAULT_BUDGET_MS);
    expect(budgetFromEnv({ A11Y_BUDGET_MS: '60000' })).toBe(60_000);
    for (const bad of ['15m', '0', '-1', '1.5']) {
      expect(() => budgetFromEnv({ A11Y_BUDGET_MS: bad })).toThrow(/A11Y_BUDGET_MS/);
    }
  });
});

describe('entryKey', () => {
  it('reads a missing theme as light, so reports from before the field still match', () => {
    expect(entryKey(entry())).toBe('orders|data|supervisor|1440|light');
    expect(entryKey(entry({ theme: 'light' }))).toBe(entryKey(entry()));
    expect(entryKey(entry({ theme: 'dark' }))).toBe('orders|data|supervisor|1440|dark');
  });
});

describe('routeSelected', () => {
  const filter = (routes: string[]) => ({ routes, roles: [], widths: [], states: [] });

  it('selects every route without a filter', () => {
    expect(routeSelected(filter([]), 'orders', '/orders')).toBe(true);
  });

  it('selects by id, or by path prefix on whole segments', () => {
    expect(routeSelected(filter(['order']), 'order', '/orders/$id')).toBe(true);
    expect(routeSelected(filter(['order']), 'orders', '/orders')).toBe(false);
    expect(routeSelected(filter(['/orders']), 'order', '/orders/$id')).toBe(true);
    expect(routeSelected(filter(['/orders/']), 'orders', '/orders')).toBe(true);
    expect(routeSelected(filter(['/order']), 'orders', '/orders')).toBe(false);
    expect(routeSelected(filter(['/']), 'overview', '/')).toBe(true);
    expect(routeSelected(filter(['/']), 'orders', '/orders')).toBe(false);
  });
});

describe('fromAxe', () => {
  it('sorts worst first, counts one per rule and treats a missing or unknown impact as serious', () => {
    const { counts, violations } = fromAxe({
      violations: [
        { id: 'region', impact: 'moderate', help: 'r', nodes: [{ target: ['main'] }] },
        { id: 'odd', impact: null, help: 'o', nodes: [] },
        { id: 'new', impact: 'severe', help: 'n', nodes: [] },
        {
          id: 'color-contrast',
          impact: 'serious',
          help: 'c',
          nodes: [{ target: ['a'] }, { target: ['b'] }, { target: ['c'] }, { target: ['d'] }],
        },
        {
          id: 'aria-valid-attr',
          impact: 'critical',
          help: 'a',
          nodes: [{ target: ['#i', 'span'] }],
        },
      ],
    });
    expect(violations.map((v) => [v.id, v.impact, v.nodes])).toEqual([
      ['aria-valid-attr', 'critical', 1],
      ['color-contrast', 'serious', 4],
      ['new', 'serious', 0],
      ['odd', 'serious', 0],
      ['region', 'moderate', 1],
    ]);
    expect(violations[0]?.targets).toEqual(['#i span']);
    expect(violations[1]?.targets).toHaveLength(3);
    expect(counts).toEqual({ critical: 1, serious: 3, moderate: 1, minor: 0 });
  });
});

describe('duplicateTitles', () => {
  it('lists each title shared by more than one route', () => {
    expect(
      duplicateTitles({ orders: 'Orders', order: 'Orders', oee: 'OEE', spc: 'SPC', holds: 'SPC' }),
    ).toEqual([
      { title: 'Orders', routes: ['order', 'orders'] },
      { title: 'SPC', routes: ['holds', 'spc'] },
    ]);
    expect(duplicateTitles({ a: 'A', b: 'B' })).toEqual([]);
  });
});

describe('longestTableRun', () => {
  it('counts consecutive stops in the same table only', () => {
    const t = (inTable: number | null) => ({ inTable });
    expect(longestTableRun([])).toBe(0);
    expect(longestTableRun([t(null), t(0), t(0), t(0), t(null), t(0)])).toBe(3);
    expect(longestTableRun([t(0), t(0), t(1), t(1), t(1), t(1)])).toBe(4);
    expect(longestTableRun([t(null), t(null)])).toBe(0);
  });
});

describe('tableRuns (G-33)', () => {
  const t = (inTable: number | null, skipsTable: number | null = null) => ({
    inTable,
    skipsTable,
  });
  const run = (n: number, table: number) => Array.from({ length: n }, () => t(table));

  it('reports a run right after a skip link past its table apart, as skipped by link', () => {
    expect(tableRuns([t(null, 0), ...run(12, 0), t(null)])).toEqual({
      longest: 0,
      skippedByLink: 12,
    });
  });

  it('counts a run as usual when the link skips another table, or is not right before it', () => {
    expect(tableRuns([t(null, 1), ...run(12, 0)])).toEqual({ longest: 12, skippedByLink: 0 });
    expect(tableRuns([t(null, 0), t(null), ...run(12, 0)])).toEqual({
      longest: 12,
      skippedByLink: 0,
    });
    // Two tables: the first behind a skip link, the second not.
    expect(tableRuns([t(null, 0), ...run(15, 0), t(null), ...run(11, 1)])).toEqual({
      longest: 11,
      skippedByLink: 15,
    });
    // Straight from one table into the next: the second run is not the skipped one.
    expect(tableRuns([t(null, 0), ...run(3, 0), ...run(10, 1)])).toEqual({
      longest: 10,
      skippedByLink: 3,
    });
    expect(longestTableRun([t(null, 0), ...run(12, 0)])).toBe(0);
  });
});

describe('diffReports', () => {
  const before = report([
    entry({
      counts: { ...zeroCounts(), serious: 1 },
      violations: [violation('color-contrast', 'serious')],
    }),
    entry({ width: 390 }),
    entry({
      route: 'oee',
      url: '/oee',
      counts: { ...zeroCounts(), minor: 1 },
      violations: [violation('x', 'minor')],
    }),
  ]);
  const after = report([
    entry({
      counts: { ...zeroCounts(), critical: 1 },
      violations: [violation('aria-valid-attr', 'critical')],
    }),
    entry({ width: 390 }),
    entry({ route: 'order', url: '/orders/PO-1' }),
    entry({
      route: 'oee',
      url: '/oee',
      counts: { ...zeroCounts(), minor: 1 },
      violations: [violation('x', 'minor')],
    }),
  ]);

  it('lists only the pages that changed (by key), with the rules each side has alone', () => {
    expect(diffReports(before, after)).toEqual([
      {
        key: 'orders|data|supervisor|1440|light',
        before: { ...zeroCounts(), serious: 1 },
        after: { ...zeroCounts(), critical: 1 },
        added: ['aria-valid-attr'],
        removed: ['color-contrast'],
      },
      {
        key: 'order|data|supervisor|1440|light',
        before: null,
        after: zeroCounts(),
        added: [],
        removed: [],
      },
    ]);
  });

  it('narrows to the filter and leaves out pages that failed to load', () => {
    const failed = report([entry({ error: 'timeout' })]);
    expect(
      diffReports(before, failed, { routes: ['orders'], roles: [], widths: [1440], states: [] }),
    ).toEqual([
      {
        key: 'orders|data|supervisor|1440|light',
        before: { ...zeroCounts(), serious: 1 },
        after: null,
        added: [],
        removed: ['color-contrast'],
      },
    ]);
    expect(
      diffReports(before, after, { routes: ['oee'], roles: [], widths: [], states: [] }),
    ).toEqual([]);
  });

  it('writes totals, the pages worse on critical or serious, and each changed page', () => {
    const md = diffMarkdown(before, after);
    expect(md).toContain('**Before:** 0 critical, 1 serious, 0 moderate, 1 minor.');
    expect(md).toContain('**After:** 1 critical, 0 serious, 0 moderate, 1 minor.');
    expect(md).toContain('more critical or serious rules than before:** 1.');
    expect(md).toContain(
      '| orders, data, supervisor, 1440, light | 0/1/0/0 | 1/0/0/0 | aria-valid-attr | color-contrast |',
    );
    expect(md).toContain(
      '| order, data, supervisor, 1440, light | not measured | 0/0/0/0 | – | – |',
    );
    expect(diffMarkdown(before, before)).toContain('No page changed.');
    // A page worse on serious alone counts too; one better on both does not.
    const serious = report([
      entry({
        counts: { ...zeroCounts(), serious: 2 },
        violations: [violation('a', 'serious'), violation('b', 'serious')],
      }),
    ]);
    expect(diffMarkdown(before, serious)).toContain(
      'more critical or serious rules than before:** 1.',
    );
    expect(diffMarkdown(serious, before)).toContain(
      'more critical or serious rules than before:** 0.',
    );
  });
});

describe('summarize', () => {
  it('reports coverage, the budget stop, each route and each rule', () => {
    const md = summarize(
      report(
        [
          entry({
            counts: { ...zeroCounts(), serious: 1 },
            violations: [violation('color-contrast', 'serious')],
          }),
          entry({ width: 390, overflowX: true }),
          entry({ route: 'oee', error: 'timeout' }),
        ],
        {
          stoppedByBudget: true,
          coverage: {
            planned: 10,
            measured: 2,
            failed: 1,
            skipped: [],
            notReached: [{ route: 'oee', state: 'data', role: 'operator', reason: 'budget' }],
            notReachedPages: 5,
            loginFailed: [
              { route: '*', state: 'data', role: 'quality', reason: 'login failed: x' },
            ],
            loginFailedPages: 2,
          },
          titles: {
            byRoute: { orders: 'Orders', order: 'Orders' },
            duplicates: duplicateTitles({ orders: 'Orders', order: 'Orders' }),
          },
        },
      ),
    );
    expect(md).toContain('(**stopped by the budget**)');
    expect(md).toContain('2 of 10 pages measured');
    expect(md).toContain(
      '1 failed to load, 5 not reached within the budget, 2 lost to a failed login (quality); 0 route',
    );
    expect(md).toContain('None: the harness only read.');
    expect(md).toContain('0 critical, 1 serious, 0 moderate, 0 minor');
    expect(md).toContain('| orders | 2 | 0 | 1 | 0 | 0 | 390 | color-contrast |');
    expect(md).not.toContain('| oee |');
    expect(md).toContain('| color-contrast | serious | 1 | 1 | color-contrast help |');
    expect(md).toContain('"Orders" (order, orders)');
    expect(md).toContain('- operator / data: 1 routes, at every width');
  });
});

describe('summarize, writes', () => {
  it('reports each write the harness caused', () => {
    expect(summarize(report([], { writes: ['POST /api/v1/alarms/x/ack'] }))).toContain(
      '**The harness caused 1:** POST /api/v1/alarms/x/ack.',
    );
  });
});

describe('iosLockFinding', () => {
  it('flags a lock by overflow alone and accepts touch-action or a fixed body', () => {
    const base = {
      htmlOverflowY: 'hidden',
      bodyOverflowY: 'visible',
      bodyPosition: 'static',
      backdropTouchAction: 'auto',
    };
    expect(iosLockFinding(base)).toHaveLength(1);
    expect(iosLockFinding({ ...base, backdropTouchAction: 'none' })).toEqual([]);
    expect(iosLockFinding({ ...base, bodyPosition: 'fixed' })).toEqual([]);
    expect(iosLockFinding({ ...base, htmlOverflowY: 'visible' })).toEqual([]);
  });
});

describe('the route catalogue', () => {
  it("lists every route of the web app's router, once", async () => {
    const dir = join(REPO, 'apps/web/src');
    const files = (await readdir(dir, { recursive: true })).filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
    );
    const paths: string[] = [];
    let creates = 0;
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8');
      const calls = [...text.matchAll(/\bcreateRoute\(/g)].length;
      if (calls === 0) continue;
      creates += calls;
      for (const m of text.matchAll(/\bpath:\s*['"`]([^'"`]+)['"`]/g)) if (m[1]) paths.push(m[1]);
    }
    // Every createRoute( has a path found here: an unmatched spelling fails loudly.
    expect(paths).toHaveLength(creates);
    const listed = ROUTES.map((r) => r.path).filter((p) => p !== '/*');
    expect(paths.length).toBeGreaterThan(20);
    expect([...listed].sort()).toEqual([...paths].sort());
    expect(new Set(ROUTES.map((r) => r.id)).size).toBe(ROUTES.length);
  });
});

describe('gateVerdict', () => {
  const coverage = green().coverage;
  const only = (over: Partial<A11yReport>, entries?: Entry[]) =>
    gateVerdict(entries === undefined ? green(over) : green(over, entries)).failures;

  it('passes a full clean run, and one with moderate and minor rules only, listing them', () => {
    expect(gateVerdict(green())).toEqual({ failures: [], listed: [], partial: [] });
    const mild = gateVerdict(
      green({}, [
        entry({
          counts: { ...zeroCounts(), moderate: 1, minor: 1 },
          violations: [violation('region', 'moderate'), violation('empty-table-header', 'minor')],
        }),
        entry({ width: 390 }),
      ]),
    );
    expect(mild.failures).toEqual([]);
    expect(mild.listed).toEqual([
      'empty-table-header (minor) on 1 pages',
      'region (moderate) on 1 pages',
    ]);
  });

  it('fails on a critical or a serious rule on any page, theme included', () => {
    for (const impact of ['critical', 'serious'] as const) {
      expect(
        only({}, [
          entry(),
          entry({
            width: 390,
            theme: 'dark',
            counts: { ...zeroCounts(), [impact]: 1 },
            violations: [violation('color-contrast', impact)],
          }),
        ]),
      ).toEqual([`color-contrast (${impact}) on 1 pages: orders data supervisor 390 dark`]);
    }
  });

  it('fails a run that did not measure everything it planned', () => {
    const cases: [Partial<A11yReport>, RegExp][] = [
      [{ coverage: { ...coverage, notReachedPages: 7, planned: 9 } }, /budget .* ran out: 7/],
      [{ stoppedByBudget: true }, /budget .* ran out: 0/],
      [
        {
          coverage: {
            ...coverage,
            planned: 9,
            loginFailedPages: 7,
            loginFailed: [{ route: '*', state: 'data', role: 'quality', reason: 'login failed' }],
          },
        },
        /7 pages lost to a failed login \(quality\)/,
      ],
      [
        {
          coverage: {
            ...coverage,
            skipped: [{ route: 'lot', state: 'data', role: 'operator', reason: 'no id' }],
          },
        },
        /1 route × state × role combinations skipped: lot data operator \(no id\)/,
      ],
      [{ coverage: { ...coverage, planned: 3 } }, /2 of 3 planned pages measured, and 1 not/],
      [
        {
          touchScroll: [
            ran(TOUCH_ENGINES[0]),
            { ...ran(TOUCH_ENGINES[1]), ran: false, findings: ['WebKit did not launch'] },
          ],
        },
        /touch scroll \(WebKit, iPhone 15 profile\) did not run: WebKit did not launch/,
      ],
      [
        {
          keyboard: [
            sample('orders', 1440, { error: 'not reached within the budget' }),
            sample('orders', 390),
          ],
        },
        /keyboard sample of orders at 1440 was not taken: not reached/,
      ],
    ];
    for (const [over, failure] of cases) {
      const failures = only(over);
      expect(failures, failure.source).toHaveLength(1);
      expect(failures[0]).toMatch(failure);
    }
    expect(gateVerdict(report([])).failures[0]).toMatch(/nothing was planned/);
  });

  it('fails on a page that failed to load or was measured before it settled', () => {
    expect(
      only({ coverage: { ...coverage, measured: 1, failed: 1 } }, [
        entry(),
        entry({ width: 390, theme: 'dark', error: 'the dark theme did not apply' }),
      ]),
    ).toEqual([
      '1 pages failed to load or measure: orders data supervisor 390 dark (the dark theme did not apply)',
    ]);
    expect(only({}, [entry(), entry({ width: 390, ready: false })])).toEqual([
      '1 pages were measured before they settled (still loading): orders data supervisor 390 light',
    ]);
  });

  it('requires every check the plan includes, whatever the spec did (review P2)', () => {
    expect(only({ keyboard: [] })).toEqual([
      'keyboard samples missing: orders at 1440, orders at 390',
    ]);
    expect(only({ keyboard: [sample('orders', 390)] })).toEqual([
      'keyboard samples missing: orders at 1440',
    ]);
    expect(only({ overlayScans: [] })).toEqual(['overlay checks missing: orders']);
    expect(only({ overlays: [drawer(390)] })).toEqual(['nav drawer checks missing at 1024']);
    expect(only({ overlays: [] })).toEqual(['nav drawer checks missing at 1024, 390']);
    expect(only({ touchScroll: [ran(TOUCH_ENGINES[0])] })).toEqual([
      'touch scrolling behind the open nav drawer was not checked in WebKit, iPhone 15 profile',
    ]);
    expect(only({ touchScroll: [] })).toEqual([
      'touch scrolling behind the open nav drawer was not checked in Chromium, phone emulation, WebKit, iPhone 15 profile',
    ]);
    // A drawer is a `nav drawer` check: another overlay at its width does not stand for it.
    expect(
      only({
        overlays: [drawer(1024), { ...drawer(390), kind: 'menu', route: 'orders' }],
      }),
    ).toEqual(['nav drawer checks missing at 390']);
    // A route that is not the supervisor's data page needs none; another such route does.
    expect(
      only({}, [entry(), entry({ width: 390 }), entry({ route: 'oee', state: 'empty' })]),
    ).toEqual([]);
    expect(
      only({}, [entry(), entry({ width: 390 }), entry({ role: 'operator', route: 'oee' })]),
    ).toEqual([]);
    expect(only({}, [entry(), entry({ width: 390 }), entry({ route: 'oee' })])).toEqual([
      'keyboard samples missing: oee at 1440, oee at 390',
      'overlay checks missing: oee',
    ]);
  });

  it('expects the checks of the widths and routes a narrowed run has, and calls it partial', () => {
    // A11Y_WIDTHS=1280: no keyboard, overlay or drawer width in the run, so none expected, but
    // the touch checks still are (the shell is in), and the run is no gate (review P1, finding 2).
    const at1280 = gateVerdict(
      report([entry({ width: 1280 })], {
        filter: { routes: [], roles: [], widths: [1280], states: [] },
        touchScroll: TOUCH_ENGINES.map(ran),
      }),
    );
    expect(at1280).toEqual({ failures: [], listed: [], partial: ['A11Y_WIDTHS=1280'] });
    // Routes without the shell: no drawer or touch check expected.
    const orders = gateVerdict(
      green(
        {
          filter: { routes: ['orders'], roles: [], widths: [], states: [] },
          overlays: [],
          touchScroll: [],
        },
        [entry(), entry({ width: 390 })],
      ),
    );
    expect(orders.failures).toEqual([]);
    expect(orders.partial).toEqual(['A11Y_ROUTES=orders']);
    // The shell alone: no page, still a run (the drawer and both touch checks).
    const shell = gateVerdict(
      report([], {
        filter: { routes: ['shell'], roles: [], widths: [], states: [] },
        coverage: { ...coverage, planned: 0, measured: 0 },
        overlays: [drawer(1024), drawer(390)],
        touchScroll: TOUCH_ENGINES.map(ran),
      }),
    );
    expect(shell.failures).toEqual([]);
    // The shell with a route that planned nothing is no shell-only run.
    expect(
      gateVerdict(
        report([], {
          filter: { routes: ['shell', 'orders'], roles: [], widths: [], states: [] },
          coverage: { ...coverage, planned: 0, measured: 0 },
          overlays: [drawer(1024), drawer(390)],
          touchScroll: TOUCH_ENGINES.map(ran),
        }),
      ).failures,
    ).toEqual(['nothing was planned: the run measured no page']);
    expect(
      gateVerdict(
        report([], {
          filter: { routes: ['shell'], roles: [], widths: [], states: [] },
          coverage: { ...coverage, planned: 0, measured: 0 },
        }),
      ).failures,
    ).toEqual([
      'nav drawer checks missing at 1024, 390',
      'touch scrolling behind the open nav drawer was not checked in Chromium, phone emulation, WebKit, iPhone 15 profile',
    ]);
  });

  it('fails on a shared title, an overlay check, a touch scroll that moved the page and a write', () => {
    expect(
      only({
        titles: {
          byRoute: { orders: 'Orders', order: 'Orders' },
          duplicates: [{ title: 'Orders', routes: ['order', 'orders'] }],
        },
        overlays: [
          drawer(1024),
          drawer(390),
          {
            route: 'alarms',
            width: 1440,
            kind: 'modal dialog',
            trigger: 'Acknowledge',
            checks: { escapeCloses: true, focusReturns: false },
            findings: ['focusReturns: no'],
          },
        ],
        touchScroll: [
          ran(TOUCH_ENGINES[0]),
          {
            ...ran(TOUCH_ENGINES[1]),
            findings: ['with the drawer open the page can still scroll 900 px'],
          },
        ],
        writes: ['POST /api/v1/alarms/x/ack'],
      }),
    ).toEqual([
      'the title "Orders" is shared by order, orders (G-05)',
      'modal dialog "Acknowledge" on alarms at 1440: focusReturns: no',
      'touch scroll (WebKit, iPhone 15 profile, /orders): with the drawer open the page can still scroll 900 px',
      'the harness caused 1 writes: POST /api/v1/alarms/x/ack',
    ]);
  });

  it('fails on a hidden or off-screen focus (2.4.7), a covered one (2.4.11) and a G-33 run', () => {
    const k = (over: Partial<KeyboardSample>) =>
      only({ keyboard: [sample('orders', 1440), sample('orders', 390, over)] });
    expect(k({ hidden: ['button "Save"'] })).toEqual([
      'no visible focus indicator (2.4.7) on orders at 390: button "Save"',
    ]);
    expect(k({ offScreen: ['a "Next"'] })).toEqual([
      'focus off screen or on a zero-size element (2.4.7) on orders at 390: a "Next"',
    ]);
    expect(k({ covered: ['a "PO-1"'] })).toEqual([
      'focused element covered by another (2.4.11) on orders at 390: a "PO-1"',
    ]);
    expect(k({ longestTableRun: 10 })).toEqual([
      '10 stops inside one table before leaving it (G-33) on orders at 390',
    ]);
    // Under the limit, or behind a skip link, it is no finding.
    expect(k({ longestTableRun: 9, skippedByLinkRun: 30 })).toEqual([]);
  });

  it('lists sideways scrolling without failing', () => {
    const verdict = gateVerdict(green({}, [entry({ overflowX: true }), entry({ width: 390 })]));
    expect(verdict.failures).toEqual([]);
    expect(verdict.listed).toEqual([
      '1 pages wider than the viewport: orders data supervisor 1440 light',
    ]);
  });

  it('shortens a long list of pages', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      entry({
        width: 400 + i,
        counts: { ...zeroCounts(), serious: 1 },
        violations: [violation('color-contrast', 'serious')],
      }),
    );
    const [failure] = only({}, [entry(), entry({ width: 390 }), ...many]);
    expect(failure).toMatch(/^color-contrast \(serious\) on 8 pages: .*404 light, and 3 more$/);
  });
});

describe('narrowedBy', () => {
  it('names every filter variable set, so a narrowed run is never the gate', () => {
    expect(narrowedBy({ routes: [], roles: [], widths: [], states: [] })).toEqual([]);
    expect(narrowedBy({ routes: [], roles: [], widths: [], states: [], themes: [] })).toEqual([]);
    expect(
      narrowedBy({
        routes: ['orders', 'shell'],
        roles: ['operator'],
        widths: [390],
        states: ['empty'],
        themes: ['dark'],
      }),
    ).toEqual([
      'A11Y_ROUTES=orders,shell',
      'A11Y_ROLES=operator',
      'A11Y_WIDTHS=390',
      'A11Y_STATES=empty',
      'A11Y_THEMES=dark',
    ]);
  });
});

describe('skipTableOf (G-33)', () => {
  it('exempts a run only behind a link whose target is past a table, rendered and focusable', () => {
    const facts = { table: 2, targetRendered: true, targetFocusable: true };
    expect(skipTableOf(facts)).toBe(2);
    expect(skipTableOf({ ...facts, table: -1 })).toBeNull();
    expect(skipTableOf({ ...facts, targetRendered: false })).toBeNull();
    expect(skipTableOf({ ...facts, targetFocusable: false })).toBeNull();
    expect(skipTableOf({ ...facts, table: 0 })).toBe(0);
  });
});

describe('a11yPreflight', () => {
  const routes = [{ id: 'orders', path: '/orders' }];

  it('returns the budget for a run that can be gated', () => {
    expect(a11yPreflight({}, 'quality', routes)).toBe(DEFAULT_BUDGET_MS);
    expect(a11yPreflight({ A11Y_BUDGET_MS: '60000' }, 'orders', routes)).toBe(60_000);
    expect(a11yPreflight({ A11Y_ROLES: 'supervisor,signed-out' }, 'alarms', routes)).toBe(
      DEFAULT_BUDGET_MS,
    );
  });

  it('refuses no browser, a last pass without the roles, and a typo', () => {
    expect(() => a11yPreflight({ RECONCILE_BROWSER: '0' }, 'quality', routes)).toThrow(
      /RECONCILE_BROWSER=0 leaves out the browser/,
    );
    expect(() => a11yPreflight({}, 'alarms', routes)).toThrow(
      /the last pass \(alarms\) has no account for operator, quality, maintenance, admin/,
    );
    expect(() => a11yPreflight({ A11Y_ROLES: 'operator' }, undefined, routes)).toThrow(
      /the last pass \(none\) has no account for operator/,
    );
    expect(() => a11yPreflight({ A11Y_ROUTES: 'ordrs' }, 'quality', routes)).toThrow(/no route/);
    expect(() => a11yPreflight({ A11Y_BUDGET_MS: '0' }, 'quality', routes)).toThrow(
      /A11Y_BUDGET_MS/,
    );
  });
});

describe('a11yOutcome', () => {
  const launched = Date.parse('2026-10-24T00:00:00.000Z');
  const text = (r: A11yReport) => JSON.stringify(r);

  it('passes a green report of this run, and says when it is partial', () => {
    expect(a11yOutcome(text(green()), 0, launched)).toEqual({ ok: true, message: 'gate passed' });
    expect(
      a11yOutcome(
        text(
          green({ filter: { routes: [], roles: [], widths: [], states: [], themes: ['dark'] } }),
        ),
        0,
        launched,
      ),
    ).toEqual({ ok: true, message: 'partial run, not the gate (narrowed: A11Y_THEMES=dark)' });
  });

  it('fails without a readable report of this run, on a red verdict, or a failed Playwright', () => {
    expect(a11yOutcome(undefined, 0, launched)).toEqual({
      ok: false,
      message:
        'the accessibility harness wrote no readable report (Playwright exit 0: no report.json)',
    });
    expect(a11yOutcome('{', 0, launched).ok).toBe(false);
    expect(a11yOutcome('{}', 0, launched).message).toMatch(/not a harness report/);
    expect(a11yOutcome(text(green()), 0, launched + 60_000).message).toMatch(/from an earlier run/);
    expect(a11yOutcome(text(green({ writes: ['POST /x'] })), 0, launched)).toEqual({
      ok: false,
      message: 'the accessibility gate failed: the harness caused 1 writes: POST /x',
    });
    expect(a11yOutcome(text(green()), 1, launched)).toEqual({
      ok: false,
      message: 'the accessibility harness failed (Playwright exit 1)',
    });
  });
});

describe('summarize, the verdict', () => {
  it('opens with the gate: passed, or failed with each reason, then what is listed', () => {
    expect(summarize(green())).toContain('**Gate: passed.**');
    const md = summarize(
      green({}, [
        entry({
          counts: { ...zeroCounts(), serious: 1, moderate: 1 },
          violations: [violation('color-contrast', 'serious'), violation('region', 'moderate')],
        }),
        entry({ width: 390 }),
      ]),
    );
    expect(md).toContain('**Gate: failed** (1):');
    expect(md).toContain(
      '- color-contrast (serious) on 1 pages: orders data supervisor 1440 light',
    );
    expect(md).toContain('Listed, not failed:\n\n- region (moderate) on 1 pages');
  });

  it('calls a narrowed run partial, never passed', () => {
    const narrowed = green({ filter: { routes: ['orders'], roles: [], widths: [], states: [] } });
    const md = summarize(narrowed);
    expect(md).toContain(
      '**Partial run: not the gate** (narrowed: A11Y_ROUTES=orders). Only the unfiltered run counts as the gate; nothing failed in what it planned.',
    );
    expect(md).not.toContain('Gate: passed');
    expect(summarize({ ...narrowed, writes: ['POST /x'] })).toContain(
      'in what it planned, 1 failed:',
    );
  });

  it('shows the run skipped by a link apart from the G-33 run', () => {
    const md = summarize(
      report([], { keyboard: [sample('lot', 390, { longestTableRun: 2, skippedByLinkRun: 35 })] }),
    );
    expect(md).toContain('| lot | 390 | 0 | 2 | 35 | – |');
  });
});

describe('diffReports, themes', () => {
  it("narrows to the filter's themes; a page without a theme is light", () => {
    const r = report([entry(), entry({ theme: 'dark', counts: { ...zeroCounts(), serious: 1 } })]);
    const empty = report([]);
    const keys = (themes: ('light' | 'dark')[]) =>
      diffReports(empty, r, { routes: [], roles: [], widths: [], states: [], themes }).map(
        (row) => row.key,
      );
    expect(keys(['dark'])).toEqual(['orders|data|supervisor|1440|dark']);
    expect(keys(['light'])).toEqual(['orders|data|supervisor|1440|light']);
    expect(keys([])).toHaveLength(2);
  });
});
