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
  iosLockFinding,
  longestTableRun,
  routeSelected,
  validateRoutes,
  budgetFromEnv,
  entryKey,
  summarize,
  zeroCounts,
  type A11yReport,
  type Entry,
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
  touchScroll: [],
  writes: [],
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
    });
    expect(filterFromEnv({})).toEqual({ routes: [], roles: [], widths: [], states: [] });
    expect(filterFromEnv({ A11Y_WIDTHS: '1440,1440,390', A11Y_ROUTES: 'orders,orders' })).toEqual({
      routes: ['orders'],
      roles: [],
      widths: [1440, 390],
      states: [],
    });
  });

  it('refuses an unknown role, width or state rather than checking nothing', () => {
    expect(() => filterFromEnv({ A11Y_ROLES: 'supervisorr' })).toThrow(/unknown role/);
    expect(() => filterFromEnv({ A11Y_WIDTHS: 'wide' })).toThrow(/not a width/);
    expect(() => filterFromEnv({ A11Y_WIDTHS: '200' })).toThrow(/not a width/);
    expect(() => filterFromEnv({ A11Y_STATES: 'loading' })).toThrow(/unknown state/);
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
  it('is 15 minutes by default and refuses anything but a positive whole number', () => {
    expect(budgetFromEnv({})).toBe(900_000);
    expect(budgetFromEnv({ A11Y_BUDGET_MS: '' })).toBe(900_000);
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
  it('sorts worst first, counts one per rule and treats a missing impact as minor', () => {
    const { counts, violations } = fromAxe({
      violations: [
        { id: 'region', impact: 'moderate', help: 'r', nodes: [{ target: ['main'] }] },
        { id: 'odd', impact: null, help: 'o', nodes: [] },
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
      ['region', 'moderate', 1],
      ['odd', 'minor', 0],
    ]);
    expect(violations[0]?.targets).toEqual(['#i span']);
    expect(violations[1]?.targets).toHaveLength(3);
    expect(counts).toEqual({ critical: 1, serious: 1, moderate: 1, minor: 1 });
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
