/**
 * The visual and accessibility harness's report (UX-1g, #321): its shape, the filter a pull request
 * narrows it with, the gate's verdict (UX-F1, #337), the human summary and the before/after diff. Pure: the Playwright project
 * (`e2e/browser/a11y`) writes the report, `src/a11y-diff.ts` compares two of them.
 */

/** axe's impact levels, worst first. */
export const IMPACTS = ['critical', 'serious', 'moderate', 'minor'] as const;
export type Impact = (typeof IMPACTS)[number];

/** The widths every page is checked at (ux-plan "Rules for every issue": responsive). */
export const WIDTHS = [1440, 1280, 1024, 768, 390] as const;

/** Each page's state: data-rich, empty (a filter or period with nothing in it), not found. */
export const STATES = ['data', 'empty', 'not-found'] as const;
export type PageState = (typeof STATES)[number];

/** The roles a page is checked as; `signed-out` for the login and the terminal's sign-on. */
export const A11Y_ROLES = [
  'supervisor',
  'operator',
  'quality',
  'maintenance',
  'admin',
  'signed-out',
] as const;
export type A11yRole = (typeof A11Y_ROLES)[number];

/** One axe rule's violation on one page at one width. */
export interface Violation {
  readonly id: string;
  readonly impact: Impact;
  readonly help: string;
  /** How many elements break the rule. */
  readonly nodes: number;
  /** The first few elements' selectors, to find them. */
  readonly targets: readonly string[];
}

export type ImpactCounts = Record<Impact, number>;

/** The colour themes (UX-12's `data-theme`); a run checks both unless `A11Y_THEMES` narrows it. */
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/**
 * The time plan (UX-F1, #337): light at every width, dark at the desktop and the phone only. The
 * dark theme changes colours, not layout, so its contrast is checked at the widest and the
 * narrowest layout; `A11Y_WIDTHS` overrides both lists (all five in dark for UX-F3's review).
 */
export const DARK_WIDTHS = [1440, 390] as const;

/** One route in one state, as one role, at one width (in one theme). */
export interface Entry {
  readonly route: string;
  readonly state: PageState;
  readonly role: A11yRole;
  readonly width: number;
  /** Absent in a report from before the field: `light`, so diffs across it keep matching. */
  readonly theme?: Theme;
  /** The path loaded, with its query. */
  readonly url: string;
  readonly title: string;
  /** Relative to the report's folder. */
  readonly screenshot: string | null;
  /** The page settled (no "Loading…" left in `main`) before it was measured. */
  readonly ready: boolean;
  /** The page scrolls sideways (wider than the viewport): only a table's or chart's frame may. */
  readonly overflowX: boolean;
  /** Violations by impact; `nodes` summed per rule is not counted here, rules are. */
  readonly counts: ImpactCounts;
  readonly violations: readonly Violation[];
  /** The page could not be measured (navigation or axe failed); counted as not covered. */
  readonly error?: string;
}

/** A combination the run did not reach (the budget) or could not build (no id for a detail). */
export interface Skipped {
  readonly route: string;
  readonly state: PageState;
  readonly role: A11yRole;
  readonly reason: string;
}

export interface FocusStop {
  readonly element: string;
  readonly region: 'nav' | 'header' | 'main' | 'other';
  readonly visible: boolean;
  readonly inTable: number | null;
  /**
   * A skip link ("Skip past the units") whose target lies past this table: the index of the first
   * table between the link and its target, `null` (or absent) otherwise.
   */
  readonly skipsTable?: number | null;
}

export interface KeyboardSample {
  readonly route: string;
  readonly role: A11yRole;
  readonly width: number;
  readonly stops: readonly FocusStop[];
  /**
   * Stops inside one table before the focus leaves it (G-33): the longest such run, leaving out a
   * run that begins right after a skip link past that table.
   */
  readonly longestTableRun: number;
  /** The longest run that begins right after a skip link past its table (reported apart). */
  readonly skippedByLinkRun?: number;
  /** Stops without a visible focus indicator (2.4.7); absent in a report from before UX-F1. */
  readonly hidden?: readonly string[];
  /** Stops off screen or on a zero-size element (2.4.7). */
  readonly offScreen?: readonly string[];
  /** Stops covered by another element, a sticky bar (2.4.11). */
  readonly covered?: readonly string[];
  readonly findings: readonly string[];
  /** The page could not be sampled (or the budget left it): a run that did not happen. */
  readonly error?: string;
}

export interface OverlayCheck {
  readonly route: string;
  readonly width: number;
  readonly kind: string;
  readonly trigger: string;
  /** Each check's outcome; `null` where it does not apply. */
  readonly checks: Readonly<Record<string, boolean | null>>;
  readonly findings: readonly string[];
}

export interface TouchScrollCheck {
  readonly engine: string;
  readonly route: string;
  readonly ran: boolean;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly findings: readonly string[];
}

export interface A11yReport {
  readonly version: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly budgetMs: number;
  readonly elapsedMs: number;
  /** The budget ran out: `coverage.notReached` lists what was left. */
  readonly stoppedByBudget: boolean;
  readonly axe: { readonly version: string; readonly tags: readonly string[] };
  readonly filter: A11yFilter;
  readonly coverage: {
    /** Pages: route × state × role × width. */
    readonly planned: number;
    readonly measured: number;
    /** Pages that failed to load or to measure. */
    readonly failed: number;
    /** Combinations without an id for their detail route (each at every width, not planned). */
    readonly skipped: readonly Skipped[];
    /** Combinations the budget left (each at every width), and their pages. */
    readonly notReached: readonly Skipped[];
    readonly notReachedPages: number;
    /** Roles whose login failed (one row each), and the planned pages it cost. */
    readonly loginFailed: readonly Skipped[];
    readonly loginFailedPages: number;
  };
  readonly entries: readonly Entry[];
  readonly titles: {
    /** The `document.title` per route: its first state measured as the supervisor (data first). */
    readonly byRoute: Readonly<Record<string, string>>;
    readonly duplicates: readonly { readonly title: string; readonly routes: readonly string[] }[];
  };
  readonly keyboard: readonly KeyboardSample[];
  readonly overlays: readonly OverlayCheck[];
  /**
   * The pages whose own overlays were looked for (at `OVERLAY_WIDTH`), each once, whether or not
   * it opens any: the gate requires one per supervisor data route.
   */
  readonly overlayScans: readonly { readonly route: string; readonly width: number }[];
  readonly touchScroll: readonly TouchScrollCheck[];
  /**
   * Requests other than GET and HEAD the harness caused, the login excepted: it must read only,
   * so each is a finding (`POST /api/v1/…`).
   */
  readonly writes: readonly string[];
}

/** What a run covers: each list empty means all. */
export interface A11yFilter {
  readonly routes: readonly string[];
  readonly roles: readonly A11yRole[];
  readonly widths: readonly number[];
  readonly states: readonly PageState[];
  /** Absent in a report from before UX-F1: every theme. */
  readonly themes?: readonly Theme[];
}

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');

/**
 * The filter from the environment: `A11Y_ROUTES` (route ids or path prefixes, `shell` for the nav
 * drawer checks), `A11Y_ROLES`, `A11Y_WIDTHS`, `A11Y_STATES`, `A11Y_THEMES`, each a comma list. An
 * unknown role, width, state or theme is an error: a typo must not silently check nothing.
 */
export function filterFromEnv(env: Readonly<Record<string, string | undefined>>): A11yFilter {
  const roles = [...new Set(list(env.A11Y_ROLES))];
  const widths = [...new Set(list(env.A11Y_WIDTHS).map(Number))];
  const states = [...new Set(list(env.A11Y_STATES))];
  const themes = [...new Set(list(env.A11Y_THEMES))];
  const badRole = roles.find((r) => !(A11Y_ROLES as readonly string[]).includes(r));
  if (badRole !== undefined) throw new Error(`A11Y_ROLES: unknown role ${badRole}`);
  const badWidth = widths.find((w) => !Number.isInteger(w) || w < 320 || w > 3840);
  if (badWidth !== undefined) throw new Error(`A11Y_WIDTHS: not a width ${String(badWidth)}`);
  const badState = states.find((s) => !(STATES as readonly string[]).includes(s));
  if (badState !== undefined) throw new Error(`A11Y_STATES: unknown state ${badState}`);
  const badTheme = themes.find((t) => !(THEMES as readonly string[]).includes(t));
  if (badTheme !== undefined) throw new Error(`A11Y_THEMES: unknown theme ${badTheme}`);
  return {
    routes: [...new Set(list(env.A11Y_ROUTES))],
    roles: roles as A11yRole[],
    widths,
    states: states as PageState[],
    themes: themes as Theme[],
  };
}

/** The pseudo-route of the shell's checks: the nav drawer and touch scrolling behind it. */
export const SHELL = 'shell';

/**
 * Every `A11Y_ROUTES` entry must be `shell`, a route id or a path prefix (`/orders`) that selects
 * at least one route: a typo throws, naming each bad entry, rather than checking nothing.
 */
export function validateRoutes(
  filter: A11yFilter,
  routes: readonly { readonly id: string; readonly path: string }[],
): void {
  const bad = filter.routes.filter(
    (entry) =>
      entry !== SHELL &&
      !routes.some((r) => r.id === entry) &&
      !(entry.startsWith('/') && routes.some((r) => pathMatches(r.path, entry))),
  );
  if (bad.length > 0) {
    throw new Error(
      `A11Y_ROUTES: no route ${bad.join(', ')} (route ids: ${routes.map((r) => r.id).join(', ')}; or a path prefix, or ${SHELL})`,
    );
  }
}

/**
 * The default budget (UX-F1, #337): the full plan (1421 pages: 203 route × state × role
 * combinations, five widths in light and two in dark) took 1567 s on an M3 MacBook Air; 40
 * minutes leaves half as much again for a slower run. A run the budget cuts fails the gate.
 */
export const DEFAULT_BUDGET_MS = 40 * 60_000;

/** `A11Y_BUDGET_MS`: a positive whole number of milliseconds, `DEFAULT_BUDGET_MS` by default. */
export function budgetFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.A11Y_BUDGET_MS;
  if (raw === undefined || raw === '') return DEFAULT_BUDGET_MS;
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`A11Y_BUDGET_MS: not a positive whole number of milliseconds: ${raw}`);
  }
  return ms;
}

/** Whether a route (its id and path pattern) passes the filter's routes. */
export function routeSelected(filter: A11yFilter, id: string, path: string): boolean {
  if (filter.routes.length === 0) return true;
  return filter.routes.some((r) => r === id || (r.startsWith('/') && pathMatches(path, r)));
}

/** `/orders` selects `/orders` and `/orders/$id`, not `/ordersx`; `/` selects only `/`. */
function pathMatches(path: string, prefix: string): boolean {
  if (prefix === '/') return path === '/';
  const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return path === p || path.startsWith(`${p}/`);
}

export const widthsOf = (filter: A11yFilter): readonly number[] =>
  filter.widths.length > 0 ? filter.widths : WIDTHS;

export const rolesOf = (filter: A11yFilter): readonly A11yRole[] =>
  filter.roles.length > 0 ? filter.roles : A11Y_ROLES;

export const statesOf = (filter: A11yFilter): readonly PageState[] =>
  filter.states.length > 0 ? filter.states : STATES;

export const themesOf = (filter: A11yFilter): readonly Theme[] =>
  filter.themes !== undefined && filter.themes.length > 0 ? filter.themes : THEMES;

/**
 * The widths a theme is measured at: every width in light, `DARK_WIDTHS` in dark; `A11Y_WIDTHS`
 * sets both.
 */
export const themeWidths = (filter: A11yFilter, theme: Theme): readonly number[] =>
  filter.widths.length > 0 ? filter.widths : theme === 'light' ? WIDTHS : DARK_WIDTHS;

/** The pages one route × state × role makes: its widths in each theme of the run. */
export const pagesPerItem = (filter: A11yFilter): number =>
  themesOf(filter).reduce((n, theme) => n + themeWidths(filter, theme).length, 0);

/** The shape of axe's result this report keeps (a structural subset of axe-core's). */
export interface AxeResultLike {
  readonly violations: readonly {
    readonly id: string;
    readonly impact?: string | null;
    readonly help: string;
    readonly nodes: readonly { readonly target: readonly unknown[] }[];
  }[];
}

const isImpact = (value: unknown): value is Impact =>
  (IMPACTS as readonly unknown[]).includes(value);

export const zeroCounts = (): ImpactCounts => ({ critical: 0, serious: 0, moderate: 0, minor: 0 });

/**
 * axe's violations, worst first, with counts by impact (one per rule). A missing or unknown impact
 * (a future axe's new level) counts as serious: the gate fails closed (UX-F1 review).
 */
export function fromAxe(result: AxeResultLike): {
  counts: ImpactCounts;
  violations: Violation[];
} {
  const violations = result.violations
    .map((v): Violation => ({
      id: v.id,
      impact: isImpact(v.impact) ? v.impact : 'serious',
      help: v.help,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n) => n.target.map(String).join(' ')),
    }))
    .sort((a, b) => IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact) || cmp(a.id, b.id));
  const counts = zeroCounts();
  for (const v of violations) counts[v.impact] += 1;
  return { counts, violations };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Titles shared by more than one route (G-05: each route's title is distinct). */
export function duplicateTitles(
  byRoute: Readonly<Record<string, string>>,
): { title: string; routes: string[] }[] {
  const routes = new Map<string, string[]>();
  for (const [route, title] of Object.entries(byRoute)) {
    routes.set(title, [...(routes.get(title) ?? []), route]);
  }
  return [...routes]
    .filter(([, r]) => r.length > 1)
    .map(([title, r]) => ({ title, routes: r.sort() }))
    .sort((a, b) => cmp(a.title, b.title));
}

/**
 * The longest runs of consecutive focus stops inside one table (G-33): `inTable` is the table's
 * index on the page, `null` outside any table. A run that begins right after a skip link past that
 * table (`skipsTable`, the design system's remedy: "Skip past the units") counts apart, as
 * `skippedByLink`, since a keyboard user had the way round it; every other run is `longest`.
 */
export function tableRuns(stops: readonly Pick<FocusStop, 'inTable' | 'skipsTable'>[]): {
  longest: number;
  skippedByLink: number;
} {
  let longest = 0;
  let skippedByLink = 0;
  let run = 0;
  let skipped = false;
  let table: number | null = null;
  let previous: Pick<FocusStop, 'inTable' | 'skipsTable'> | undefined;
  for (const stop of stops) {
    if (stop.inTable !== null && stop.inTable === table) run += 1;
    else if (stop.inTable === null) run = 0;
    else {
      run = 1;
      skipped = previous?.skipsTable === stop.inTable;
    }
    table = stop.inTable;
    previous = stop;
    if (skipped) skippedByLink = Math.max(skippedByLink, run);
    else longest = Math.max(longest, run);
  }
  return { longest, skippedByLink };
}

/** The longest run inside one table that no skip link offers a way past (G-33). */
export const longestTableRun = (stops: readonly Pick<FocusStop, 'inTable' | 'skipsTable'>[]) =>
  tableRuns(stops).longest;

/** A run of this many stops inside one table is a G-33 finding. */
export const TABLE_RUN_LIMIT = 10;

/**
 * The most Tab presses a keyboard sample takes (UX-F1 review): it samples the whole page, so this
 * is far above any page's order (the largest seen: under 100 stops, a lot's 50-unit table).
 */
export const TAB_PRESS_CAP = 400;

/** A sample that reached the cap before the focus wrapped round or left the page: not taken. */
export const keyboardCapError = (
  pressed: number,
  cap: number,
  ended: boolean,
): string | undefined =>
  !ended && pressed >= cap
    ? `the Tab order did not end within ${String(cap)} presses: the sample is cut off`
    : undefined;

/** Keyboard sampling widths: the desktop and the phone (the drawer layout). */
export const KEYBOARD_WIDTHS = [1440, 390] as const;
/** The width each page's own overlays are checked at. */
export const OVERLAY_WIDTH = 1440;
/** The nav drawer is checked below the `xl` breakpoint (1280 px), at these widths. */
export const DRAWER_WIDTHS = [1024, 390] as const;
/** The engines of the touch-scroll check behind the open drawer; the gate needs both. */
export const TOUCH_ENGINES = ['Chromium, phone emulation', 'WebKit, iPhone 15 profile'] as const;

/** What the page says about a focused link that may skip past a table (`probe.ts`). */
export interface SkipFacts {
  /** The index of the first table between the link and its target; -1 when none or no target. */
  readonly table: number;
  /** The target is rendered: it has a box, is not `hidden` or `display: none`, not inert. */
  readonly targetRendered: boolean;
  /** The target takes the focus: focusable itself, or the link moves the focus to it. */
  readonly targetFocusable: boolean;
  /** The link is marked as a skip link (`data-skip-link`, DataTable's, in table or card mode). */
  readonly marked?: boolean;
  /** The target lies after the link in the document (following it moves forward). */
  readonly targetAfter?: boolean;
  /** The Tab stops between the link and its target: what following the link passes over. */
  readonly between?: number;
}

/**
 * Whether the keyboard sample follows the focused link to its target, as a keyboard user would
 * (UX-F1): a skip link forward, to a rendered target that takes the focus, past a table (the
 * G-33 exemption's rule) or marked as DataTable's (its card list on a phone). The sample then
 * goes on from the target, bounded by the page's structure rather than its data; what it passed
 * over is the run "skipped by link".
 */
export const followsSkip = (facts: SkipFacts): boolean =>
  facts.targetRendered &&
  facts.targetFocusable &&
  facts.targetAfter === true &&
  (facts.table >= 0 || facts.marked === true);

/**
 * The table a focused link skips past (G-33), or `null`: only a link whose target lies past a
 * table and is rendered and takes the focus offers a way past the run (UX-F1 review: a link into
 * a closed panel moves nothing).
 */
export const skipTableOf = (facts: SkipFacts): number | null =>
  facts.table >= 0 && facts.targetRendered && facts.targetFocusable ? facts.table : null;

/** The filter variables a run was narrowed by: any of them makes it a partial run. */
export function narrowedBy(filter: A11yFilter): string[] {
  return [
    filter.routes.length > 0 ? `A11Y_ROUTES=${filter.routes.join(',')}` : '',
    filter.roles.length > 0 ? `A11Y_ROLES=${filter.roles.join(',')}` : '',
    filter.widths.length > 0 ? `A11Y_WIDTHS=${filter.widths.join(',')}` : '',
    filter.states.length > 0 ? `A11Y_STATES=${filter.states.join(',')}` : '',
    filter.themes !== undefined && filter.themes.length > 0
      ? `A11Y_THEMES=${filter.themes.join(',')}`
      : '',
  ].filter((t) => t !== '');
}

/** The passes whose stack has a user per role (the orders pass makes them; quality follows it). */
export const PASSES_WITH_ROLES: readonly string[] = ['orders', 'quality'];

/**
 * The reconciliation's checks before any stack starts when `RECONCILE_A11Y=1` (UX-F1): the
 * variables, a browser (`RECONCILE_BROWSER=0` would leave the gate out and the run green), and a
 * last pass with a user per role unless `A11Y_ROLES` keeps to the supervisor and signed out (on
 * `alarms` the other roles have no account, and every run would be red). Throws the reason.
 */
export function a11yPreflight(
  env: Readonly<Record<string, string | undefined>>,
  lastPass: string | undefined,
  routes: readonly { readonly id: string; readonly path: string }[],
): number {
  const budget = budgetFromEnv(env);
  const filter = filterFromEnv(env);
  validateRoutes(filter, routes);
  if (env.RECONCILE_BROWSER === '0') {
    throw new Error(
      'RECONCILE_BROWSER=0 leaves out the browser, so the accessibility gate cannot run',
    );
  }
  const needAccounts = rolesOf(filter).filter((r) => r !== 'supervisor' && r !== 'signed-out');
  if (needAccounts.length > 0 && !PASSES_WITH_ROLES.includes(lastPass ?? '')) {
    throw new Error(
      `the last pass (${lastPass ?? 'none'}) has no account for ${needAccounts.join(', ')}: end RECONCILE_PASSES with ${PASSES_WITH_ROLES.join(' or ')}, or narrow A11Y_ROLES to supervisor,signed-out`,
    );
  }
  return budget;
}

/**
 * The reconciliation's reading of a harness run (UX-F1): the report must be there, written by
 * this run (`startedAt` not before `launchedAt`), and its verdict must hold whatever Playwright's
 * exit code said. `ok` false fails the pass with `message`; a partial run passes and says so.
 */
export function a11yOutcome(
  reportText: string | undefined,
  exitCode: number,
  launchedAt: number,
  catalogue: readonly CatalogueRoute[],
): { ok: boolean; message: string } {
  let parsed: unknown;
  try {
    if (reportText === undefined) throw new Error('no report.json');
    parsed = JSON.parse(reportText);
  } catch (error) {
    return {
      ok: false,
      message: `the accessibility harness wrote no readable report (Playwright exit ${String(exitCode)}: ${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const bad = malformedFields(parsed);
  if (bad.length > 0) {
    return {
      ok: false,
      message: `malformed report.json (Playwright exit ${String(exitCode)}): missing or wrong ${bad.join(', ')}`,
    };
  }
  const report = parsed as A11yReport;
  // `startedAt` is a date here: `malformedFields` refused one that does not parse (re-review).
  if (Date.parse(report.startedAt) < launchedAt - 1000) {
    return {
      ok: false,
      message: `report.json is from an earlier run (started ${report.startedAt}; Playwright exit ${String(exitCode)})`,
    };
  }
  const verdict = gateVerdict(report, catalogue);
  if (verdict.failures.length > 0) {
    return {
      ok: false,
      message: `the accessibility gate failed: ${verdict.failures.join('; ')}`,
    };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      message: `the accessibility harness failed (Playwright exit ${String(exitCode)})`,
    };
  }
  return {
    ok: true,
    message:
      verdict.partial.length > 0
        ? `partial run, not the gate (narrowed: ${verdict.partial.join(' ')})`
        : 'gate passed',
  };
}

/** A page's key: a missing theme is `light`, so a report from before the field still matches. */
export const entryKey = (e: Pick<Entry, 'route' | 'state' | 'role' | 'width' | 'theme'>): string =>
  `${e.route}|${e.state}|${e.role}|${String(e.width)}|${e.theme ?? 'light'}`;

const sum = (a: ImpactCounts, b: ImpactCounts): ImpactCounts => ({
  critical: a.critical + b.critical,
  serious: a.serious + b.serious,
  moderate: a.moderate + b.moderate,
  minor: a.minor + b.minor,
});

const countsText = (c: ImpactCounts) => IMPACTS.map((i) => `${String(c[i])} ${i}`).join(', ');

/** Markdown table cell text: a pipe would end the cell. */
const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

/**
 * The human summary (markdown): coverage, totals by impact, each route's worst page, the rules seen
 * most, titles, keyboard, overlays and the touch-scroll check.
 */
export function summarize(report: A11yReport, catalogue?: readonly CatalogueRoute[]): string {
  const measured = report.entries.filter((e) => e.error === undefined);
  const total = measured.reduce((acc, e) => sum(acc, e.counts), zeroCounts());
  const out: string[] = [];
  const verdict = gateVerdict(report, catalogue);
  out.push('# Visual and accessibility harness (UX-1g, gate UX-F1)', '');
  out.push(
    verdict.partial.length > 0
      ? `**Partial run: not the gate** (narrowed: ${verdict.partial.join(' ')}). Only the unfiltered run counts as the gate; ${verdict.failures.length === 0 ? 'nothing failed in what it planned.' : `in what it planned, ${String(verdict.failures.length)} failed:`}`
      : verdict.failures.length === 0
        ? '**Gate: passed.** Every planned page measured; no critical or serious rule; titles distinct; keyboard, overlays, the drawer and touch scrolling behind it checked; no write.'
        : `**Gate: failed** (${String(verdict.failures.length)}):`,
    '',
  );
  if (verdict.failures.length > 0) {
    for (const f of verdict.failures) out.push(`- ${f}`);
    out.push('');
  }
  if (verdict.listed.length > 0) {
    out.push('Listed, not failed:', '');
    for (const l of verdict.listed) out.push(`- ${l}`);
    out.push('');
  }
  out.push(
    `axe ${report.axe.version} (${report.axe.tags.join(', ')}), ${String(
      Math.round(report.elapsedMs / 1000),
    )} s of a ${String(Math.round(report.budgetMs / 60_000))}-minute budget${
      report.stoppedByBudget ? ' (**stopped by the budget**)' : ''
    }.`,
    '',
  );
  const f = report.filter;
  const filterText = [
    f.routes.length > 0 ? `routes ${f.routes.join(', ')}` : '',
    f.roles.length > 0 ? `roles ${f.roles.join(', ')}` : '',
    f.widths.length > 0 ? `widths ${f.widths.join(', ')}` : '',
    f.states.length > 0 ? `states ${f.states.join(', ')}` : '',
    f.themes !== undefined && f.themes.length > 0 ? `themes ${f.themes.join(', ')}` : '',
  ].filter((t) => t !== '');
  out.push(
    `- **Coverage:** ${String(report.coverage.measured)} of ${String(report.coverage.planned)} pages measured (route × state × role × width × theme), ${String(report.coverage.failed)} failed to load, ${String(report.coverage.notReachedPages)} not reached within the budget, ${String(report.coverage.loginFailedPages)} lost to a failed login${report.coverage.loginFailed.length > 0 ? ` (${report.coverage.loginFailed.map((l) => l.role).join(', ')})` : ''}; ${String(report.coverage.skipped.length)} route × state × role combinations skipped (no id).${filterText.length > 0 ? ` Filter: ${filterText.join('; ')}.` : ''}`,
    `- **Rule violations (rule × page):** ${countsText(total)}.`,
    `- **Pages wider than the viewport:** ${String(measured.filter((e) => e.overflowX).length)}.`,
    '',
  );

  // Each route's worst page by (critical, serious) and the rules it breaks.
  const byRoute = new Map<string, Entry[]>();
  for (const e of measured) byRoute.set(e.route, [...(byRoute.get(e.route) ?? []), e]);
  out.push('## Routes', '');
  out.push(
    '| Route | Pages | Critical | Serious | Moderate | Minor | Sideways scroll at | Rules |',
    '| --- | --: | --: | --: | --: | --: | --- | --- |',
  );
  for (const [route, entries] of [...byRoute].sort(([a], [b]) => cmp(a, b))) {
    const max = (i: Impact) => Math.max(...entries.map((e) => e.counts[i]));
    const rules = new Set(entries.flatMap((e) => e.violations.map((v) => v.id)));
    const overflow = [...new Set(entries.filter((e) => e.overflowX).map((e) => e.width))].sort(
      (a, b) => b - a,
    );
    out.push(
      `| ${route} | ${String(entries.length)} | ${IMPACTS.map((i) => String(max(i))).join(' | ')} | ${overflow.join(', ') || '–'} | ${[...rules].sort().join(', ') || '–'} |`,
    );
  }
  out.push('', 'Counts are the most rules of that impact on any one page of the route.', '');

  const rules = new Map<string, { impact: Impact; help: string; pages: number; nodes: number }>();
  for (const e of measured) {
    for (const v of e.violations) {
      const r = rules.get(v.id) ?? { impact: v.impact, help: v.help, pages: 0, nodes: 0 };
      rules.set(v.id, { ...r, pages: r.pages + 1, nodes: r.nodes + v.nodes });
    }
  }
  out.push('## Rules', '');
  if (rules.size === 0) out.push('No violation.', '');
  else {
    out.push('| Rule | Impact | Pages | Elements | Help |', '| --- | --- | --: | --: | --- |');
    for (const [id, r] of [...rules].sort(
      ([a, x], [b, y]) =>
        IMPACTS.indexOf(x.impact) - IMPACTS.indexOf(y.impact) || y.pages - x.pages || cmp(a, b),
    )) {
      out.push(
        `| ${id} | ${r.impact} | ${String(r.pages)} | ${String(r.nodes)} | ${cell(r.help)} |`,
      );
    }
    out.push('');
  }

  out.push('## Page titles', '');
  const titled = Object.keys(report.titles.byRoute).length;
  out.push(
    report.titles.duplicates.length === 0
      ? `${String(titled)} routes, every title distinct.`
      : `${String(titled)} routes; shared titles: ${report.titles.duplicates
          .map((d) => `"${d.title}" (${d.routes.join(', ')})`)
          .join('; ')}.`,
    '',
  );

  out.push('## Keyboard', '');
  if (report.keyboard.length === 0) out.push('Not sampled.', '');
  else {
    out.push(
      '| Route | Width | Stops | Longest run in one table | Skipped by link | Findings |',
      '| --- | --: | --: | --: | --: | --- |',
    );
    for (const k of report.keyboard) {
      const findings = k.error === undefined ? k.findings : [`not sampled: ${k.error}`];
      out.push(
        `| ${k.route} | ${String(k.width)} | ${String(k.stops.length)} | ${String(k.longestTableRun)} | ${String(k.skippedByLinkRun ?? 0)} | ${cell(findings.join('; ')) || '–'} |`,
      );
    }
    out.push(
      '',
      `"Skipped by link": the longest run inside one table that begins right after a skip link past that table (the design system's remedy for G-33); not a finding.`,
    );
    out.push('');
  }

  out.push('## Overlays', '');
  if (report.overlays.length === 0) out.push('None found.', '');
  else {
    out.push(
      '| Route | Width | Kind | Trigger | Checks | Findings |',
      '| --- | --: | --- | --- | --- | --- |',
    );
    for (const o of report.overlays) {
      const checks = Object.entries(o.checks)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `${k} ${v ? 'yes' : '**no**'}`)
        .join(', ');
      out.push(
        `| ${o.route} | ${String(o.width)} | ${o.kind} | ${cell(o.trigger)} | ${checks} | ${cell(o.findings.join('; ')) || '–'} |`,
      );
    }
    out.push('');
  }

  out.push('## Writes', '');
  out.push(
    report.writes.length === 0
      ? 'None: the harness only read.'
      : `**The harness caused ${String(report.writes.length)}:** ${report.writes.slice(0, 10).join('; ')}.`,
    '',
  );

  out.push('## Touch scrolling behind the open nav drawer', '');
  if (report.touchScroll.length === 0) out.push('Not run.', '');
  for (const t of report.touchScroll) {
    out.push(
      `- **${t.engine}** (${t.route}): ${t.ran ? (t.findings.length === 0 ? 'no finding' : t.findings.join('; ')) : `not run: ${t.findings.join('; ')}`}.`,
    );
  }
  out.push('');
  if (report.coverage.notReached.length > 0) {
    out.push('## Not reached within the budget', '');
    const groups = new Map<string, number>();
    for (const s of report.coverage.notReached) {
      const k = `${s.role} / ${s.state}`;
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
    for (const [k, n] of groups) out.push(`- ${k}: ${String(n)} routes, at every width`);
    out.push('');
  }
  return out.join('\n');
}

const NO_FILTER: A11yFilter = { routes: [], roles: [], widths: [], states: [], themes: [] };

/** A measured page inside the filter (its routes by id here: entries carry no path pattern). */
const kept =
  (filter: A11yFilter) =>
  (e: Entry): boolean =>
    e.error === undefined &&
    (filter.routes.length === 0 || filter.routes.includes(e.route)) &&
    (filter.roles.length === 0 || filter.roles.includes(e.role)) &&
    (filter.widths.length === 0 || filter.widths.includes(e.width)) &&
    (filter.states.length === 0 || filter.states.includes(e.state)) &&
    (filter.themes === undefined ||
      filter.themes.length === 0 ||
      filter.themes.includes(e.theme ?? 'light'));

export interface DiffRow {
  readonly key: string;
  readonly before: ImpactCounts | null;
  readonly after: ImpactCounts | null;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Before and after, page by page (route × state × role × width), limited to `filter`'s routes,
 * roles, widths and states: the counts on each side and the rules each side has alone. Pages
 * measured on one side only appear with `null` on the other.
 */
export function diffReports(
  before: Pick<A11yReport, 'entries'>,
  after: Pick<A11yReport, 'entries'>,
  filter: A11yFilter = NO_FILTER,
): DiffRow[] {
  const keep = kept(filter);
  const index = (entries: readonly Entry[]) =>
    new Map(entries.filter(keep).map((e) => [entryKey(e), e] as const));
  const b = index(before.entries);
  const a = index(after.entries);
  const keys = [...new Set([...b.keys(), ...a.keys()])].sort();
  return keys.flatMap((key): DiffRow[] => {
    const x = b.get(key);
    const y = a.get(key);
    const rulesX = new Set(x?.violations.map((v) => v.id) ?? []);
    const rulesY = new Set(y?.violations.map((v) => v.id) ?? []);
    const added = [...rulesY].filter((r) => !rulesX.has(r)).sort();
    const removed = [...rulesX].filter((r) => !rulesY.has(r)).sort();
    const same =
      x !== undefined &&
      y !== undefined &&
      added.length === 0 &&
      removed.length === 0 &&
      IMPACTS.every((i) => x.counts[i] === y.counts[i]);
    if (same) return [];
    return [{ key, before: x?.counts ?? null, after: y?.counts ?? null, added, removed }];
  });
}

/** The diff as markdown: totals on each side, then each changed page. */
export function diffMarkdown(
  before: Pick<A11yReport, 'entries'>,
  after: Pick<A11yReport, 'entries'>,
  filter: A11yFilter = NO_FILTER,
): string {
  const rows = diffReports(before, after, filter);
  const totals = (r: Pick<A11yReport, 'entries'>) =>
    r.entries.filter(kept(filter)).reduce((acc, e) => sum(acc, e.counts), zeroCounts());
  const out = ['# Accessibility diff (UX-1g harness)', ''];
  out.push(`- **Before:** ${countsText(totals(before))}.`);
  out.push(`- **After:** ${countsText(totals(after))}.`);
  const seriousAdded = rows.filter(
    (r) =>
      r.after !== null &&
      (r.before === null
        ? r.after.critical + r.after.serious > 0
        : r.after.critical > r.before.critical || r.after.serious > r.before.serious),
  );
  out.push(
    `- **Pages with more critical or serious rules than before:** ${String(seriousAdded.length)}.`,
    '',
  );
  if (rows.length === 0) {
    out.push('No page changed.');
    return `${out.join('\n')}\n`;
  }
  const c = (x: ImpactCounts | null) =>
    x === null ? 'not measured' : IMPACTS.map((i) => String(x[i])).join('/');
  out.push(
    '| Page (route, state, role, width, theme) | Before (c/s/m/m) | After | New rules | Gone rules |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const r of rows) {
    out.push(
      `| ${r.key.replaceAll('|', ', ')} | ${c(r.before)} | ${c(r.after)} | ${r.added.join(', ') || '–'} | ${r.removed.join(', ') || '–'} |`,
    );
  }
  return `${out.join('\n')}\n`;
}

/**
 * The iOS rule of thumb (#321's comment, from the #351 review) on the open drawer's lock styles:
 * `overflow: hidden` on the root alone does not stop touch scrolling in iOS Safari;
 * `touch-action: none` on the backdrop, or a `position: fixed` body, does.
 */
export function iosLockFinding(styles: Readonly<Record<string, string>>): string[] {
  const overflowOnly =
    (styles.htmlOverflowY === 'hidden' || styles.bodyOverflowY === 'hidden') &&
    styles.bodyPosition !== 'fixed' &&
    styles.backdropTouchAction !== 'none';
  return overflowOnly
    ? [
        'the page behind the open drawer is locked by overflow: hidden alone, which iOS Safari does not honour for touch scrolling (touch-action: none on the backdrop or a position: fixed body would)',
      ]
    : [];
}

/**
 * The live connection as a page shows it (#398): the header's status (`connection-status`'s
 * `data-status`) and whether the offline bar is up. The drawer check measures only once it is
 * settled, connected or already shown as lost: a bar that appears while the drawer is open lies
 * above `main` in the locked page and moves it (WebKit's live socket is not routed, so there the
 * bar comes a moment after the page loads).
 */
export interface ConnectionState {
  readonly status: string | null;
  readonly bar: boolean;
}

export function connectionSettled(state: ConnectionState): boolean {
  return state.bar || state.status === 'open';
}

/** What sits above `main` (#398): the offline bar's height (0 without one) and the top bar's. */
export interface AboveMain {
  readonly bar: number;
  readonly topBar: number;
}

/**
 * What changed above `main` between two measurements of the drawer check, or `undefined`: then
 * a change of `main`'s place is the drawer's own doing; otherwise it is measured once more.
 */
export function aboveMainChange(
  from: AboveMain,
  to: AboveMain,
  between: string,
): string | undefined {
  const changes = [
    from.bar === to.bar
      ? undefined
      : from.bar === 0
        ? `the offline bar appeared (${String(to.bar)} px)`
        : to.bar === 0
          ? 'the offline bar went'
          : `the offline bar's height went from ${String(from.bar)} to ${String(to.bar)} px`,
    from.topBar === to.topBar
      ? undefined
      : `the top bar's height went from ${String(from.topBar)} to ${String(to.topBar)} px`,
  ].filter((change) => change !== undefined);
  return changes.length === 0 ? undefined : `${between}: ${changes.join('; ')}`;
}

/** The impacts that fail the gate; moderate and minor are listed. */
export const FAILING_IMPACTS: readonly Impact[] = ['critical', 'serious'];

/** At most this many examples per line of the verdict. */
const EXAMPLES = 5;

const examples = (items: readonly string[]) =>
  `${items.slice(0, EXAMPLES).join(', ')}${items.length > EXAMPLES ? `, and ${String(items.length - EXAMPLES)} more` : ''}`;

/** A page as the verdict names it: route, state, role, width, theme. */
const pageName = (e: Entry) =>
  `${e.route} ${e.state} ${e.role} ${String(e.width)} ${e.theme ?? 'light'}`;

export interface GateVerdict {
  /** Each reason the gate fails; empty when it passes. */
  readonly failures: readonly string[];
  /** What is reported but does not fail it: moderate and minor rules, sideways scrolling. */
  readonly listed: readonly string[];
  /**
   * The filter variables the run was narrowed by: a partial run, never the gate, even with no
   * failure (only the unfiltered run counts).
   */
  readonly partial: readonly string[];
}

/** A route of the catalogue (`e2e/browser/a11y/routes.ts`), as far as the verdict needs it. */
export interface CatalogueRoute {
  readonly id: string;
  readonly states: Partial<Record<PageState, unknown>>;
  readonly signedOutOnly?: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The fields of a report the gate reads that are missing or of the wrong kind (UX-F1
 * re-review): a malformed report is named as such, never a TypeError. Empty for a sound one.
 */
export function malformedFields(value: unknown): string[] {
  if (!isObject(value)) return ['the report itself'];
  const bad: string[] = [];
  if (typeof value.startedAt !== 'string' || Number.isNaN(Date.parse(value.startedAt)))
    bad.push('startedAt');
  for (const key of ['entries', 'keyboard', 'overlays', 'overlayScans', 'touchScroll', 'writes'])
    if (!Array.isArray(value[key])) bad.push(key);
  if (typeof value.budgetMs !== 'number') bad.push('budgetMs');
  const coverage = value.coverage;
  if (!isObject(coverage)) bad.push('coverage');
  else {
    for (const key of ['planned', 'measured', 'failed', 'notReachedPages', 'loginFailedPages'])
      if (typeof coverage[key] !== 'number') bad.push(`coverage.${key}`);
    for (const key of ['skipped', 'notReached', 'loginFailed'])
      if (!Array.isArray(coverage[key])) bad.push(`coverage.${key}`);
  }
  const filter = value.filter;
  if (!isObject(filter)) bad.push('filter');
  else {
    for (const key of ['routes', 'roles', 'widths', 'states'])
      if (!Array.isArray(filter[key])) bad.push(`filter.${key}`);
  }
  if (!isObject(value.titles) || !Array.isArray(value.titles.duplicates))
    bad.push('titles.duplicates');
  return bad;
}

/** The keyboard findings that fail the gate, from a sample's structured lists. */
function keyboardFailures(k: KeyboardSample): string[] {
  const where = `${k.route} at ${String(k.width)}`;
  const out: string[] = [];
  if ((k.hidden ?? []).length > 0)
    out.push(`no visible focus indicator (2.4.7) on ${where}: ${examples(k.hidden ?? [])}`);
  if ((k.offScreen ?? []).length > 0)
    out.push(
      `focus off screen or on a zero-size element (2.4.7) on ${where}: ${examples(k.offScreen ?? [])}`,
    );
  if ((k.covered ?? []).length > 0)
    out.push(
      `focused element covered by another (2.4.11) on ${where}: ${examples(k.covered ?? [])}`,
    );
  if (k.longestTableRun >= TABLE_RUN_LIMIT)
    out.push(
      `${String(k.longestTableRun)} stops inside one table before leaving it (G-33) on ${where}`,
    );
  return out;
}

/**
 * The accessibility gate (UX-F1, #337) over a harness report. It fails on:
 * - a run that did not measure everything it planned: nothing planned (a shell-only run aside),
 *   a page that failed to load or measure, a page measured before it settled, a page the budget
 *   left, a role whose login failed, a combination skipped, or a count that does not add up;
 * - any critical or serious axe rule on any page (every route, state, role, width and theme);
 * - a title shared by two routes (G-05);
 * - a check the plan includes that is missing, did not run or failed: a keyboard sample per
 *   supervisor data route at each of `KEYBOARD_WIDTHS` in the run, an overlay scan per such
 *   route at `OVERLAY_WIDTH`, and with the shell the nav drawer at each of `DRAWER_WIDTHS` and
 *   touch scrolling behind it in both `TOUCH_ENGINES`;
 * - a keyboard finding: no visible focus or focus off screen (2.4.7), focus covered (2.4.11), a
 *   long Tab run through one table no skip link offers a way past (G-33);
 * - any write the harness caused.
 * Moderate and minor rules and sideways scrolling are listed. A run narrowed by any filter is
 * `partial`: not the gate, whatever its failures.
 */
export function gateVerdict(
  report: A11yReport,
  catalogue?: readonly CatalogueRoute[],
): GateVerdict {
  const failures: string[] = [];
  const listed: string[] = [];
  const partial = narrowedBy(report.filter);
  const c = report.coverage;
  const shell = report.filter.routes.length === 0 || report.filter.routes.includes(SHELL);
  const shellOnly =
    report.filter.routes.length > 0 && report.filter.routes.every((r) => r === SHELL);
  if (c.planned === 0 && !shellOnly) failures.push('nothing was planned: the run measured no page');
  if (c.failed > 0) {
    const failed = report.entries.filter((e) => e.error !== undefined);
    failures.push(
      `${String(c.failed)} pages failed to load or measure: ${examples(failed.map((e) => `${pageName(e)} (${e.error ?? ''})`))}`,
    );
  }
  const unsettled = report.entries.filter((e) => e.error === undefined && !e.ready);
  if (unsettled.length > 0) {
    failures.push(
      `${String(unsettled.length)} pages were measured before they settled (still loading): ${examples(unsettled.map(pageName))}`,
    );
  }
  if (c.notReachedPages > 0 || report.stoppedByBudget) {
    failures.push(
      `the budget (${String(Math.round(report.budgetMs / 1000))} s) ran out: ${String(c.notReachedPages)} pages not reached`,
    );
  }
  if (c.loginFailedPages > 0 || c.loginFailed.length > 0) {
    failures.push(
      `${String(c.loginFailedPages)} pages lost to a failed login (${c.loginFailed.map((l) => l.role).join(', ')})`,
    );
  }
  if (c.skipped.length > 0) {
    failures.push(
      `${String(c.skipped.length)} route × state × role combinations skipped: ${examples(c.skipped.map((s) => `${s.route} ${s.state} ${s.role} (${s.reason})`))}`,
    );
  }
  const accounted = c.measured + c.failed + c.notReachedPages + c.loginFailedPages;
  if (c.planned > 0 && accounted !== c.planned) {
    failures.push(
      `${String(c.measured)} of ${String(c.planned)} planned pages measured, and ${String(c.planned - accounted)} not accounted for`,
    );
  }

  const measured = report.entries.filter((e) => e.error === undefined);
  const bad = new Map<string, { impact: Impact; pages: string[] }>();
  const mild = new Map<string, { impact: Impact; pages: number }>();
  for (const e of measured) {
    for (const v of e.violations) {
      if (FAILING_IMPACTS.includes(v.impact)) {
        const r = bad.get(v.id) ?? { impact: v.impact, pages: [] };
        bad.set(v.id, { ...r, pages: [...r.pages, pageName(e)] });
      } else {
        const r = mild.get(v.id) ?? { impact: v.impact, pages: 0 };
        mild.set(v.id, { ...r, pages: r.pages + 1 });
      }
    }
  }
  for (const [id, r] of [...bad].sort(([a], [b]) => cmp(a, b))) {
    failures.push(`${id} (${r.impact}) on ${String(r.pages.length)} pages: ${examples(r.pages)}`);
  }
  for (const [id, r] of [...mild].sort(([a], [b]) => cmp(a, b))) {
    listed.push(`${id} (${r.impact}) on ${String(r.pages)} pages`);
  }

  for (const d of report.titles.duplicates) {
    failures.push(`the title "${d.title}" is shared by ${d.routes.join(', ')} (G-05)`);
  }

  // An unfiltered run covers the catalogue (`routes.ts`): every route, and the supervisor's data
  // page of each that has one, so the required checks below cannot vanish with a page left out
  // of the plan (UX-F1 re-review).
  if (catalogue !== undefined && partial.length === 0) {
    const absent = catalogue.filter((r) => !report.entries.some((e) => e.route === r.id));
    if (absent.length > 0)
      failures.push(`routes left out of the run: ${examples(absent.map((r) => r.id))}`);
    const noData = catalogue
      .filter((r) => r.states.data !== undefined && r.signedOutOnly !== true)
      .filter(
        (r) =>
          !absent.includes(r) &&
          !report.entries.some(
            (e) => e.route === r.id && e.role === 'supervisor' && e.state === 'data',
          ),
      );
    if (noData.length > 0)
      failures.push(
        `supervisor data pages left out of the run: ${examples(noData.map((r) => r.id))}`,
      );
  }

  // The checks the plan includes, each required (the verdict does not trust the spec's flow).
  const widths = report.filter.widths.length > 0 ? report.filter.widths : WIDTHS;
  const supervisorRoutes = [
    ...new Set(
      report.entries
        .filter((e) => e.role === 'supervisor' && e.state === 'data')
        .map((e) => e.route),
    ),
  ].sort();
  const missingKeyboard = supervisorRoutes.flatMap((route) =>
    KEYBOARD_WIDTHS.filter((w) => widths.includes(w))
      .filter(
        (w) =>
          !report.keyboard.some(
            (k) => k.route === route && k.width === w && k.role === 'supervisor',
          ),
      )
      .map((w) => `${route} at ${String(w)}`),
  );
  if (missingKeyboard.length > 0)
    failures.push(`keyboard samples missing: ${examples(missingKeyboard)}`);
  const missingScans = widths.includes(OVERLAY_WIDTH)
    ? supervisorRoutes.filter(
        (route) => !report.overlayScans.some((o) => o.route === route && o.width === OVERLAY_WIDTH),
      )
    : [];
  if (missingScans.length > 0) failures.push(`overlay checks missing: ${examples(missingScans)}`);
  if (shell) {
    const drawers = DRAWER_WIDTHS.filter((w) => widths.includes(w)).filter(
      (w) => !report.overlays.some((o) => o.kind === 'nav drawer' && o.width === w),
    );
    if (drawers.length > 0)
      failures.push(`nav drawer checks missing at ${drawers.map(String).join(', ')}`);
    const engines = TOUCH_ENGINES.filter((e) => !report.touchScroll.some((t) => t.engine === e));
    if (engines.length > 0)
      failures.push(
        `touch scrolling behind the open nav drawer was not checked in ${engines.join(', ')}`,
      );
  }
  for (const o of report.overlays) {
    if (o.findings.length > 0) {
      failures.push(
        `${o.kind} "${o.trigger}" on ${o.route} at ${String(o.width)}: ${o.findings.join('; ')}`,
      );
    }
  }
  for (const t of report.touchScroll) {
    if (!t.ran) failures.push(`touch scroll (${t.engine}) did not run: ${t.findings.join('; ')}`);
    else if (t.findings.length > 0)
      failures.push(`touch scroll (${t.engine}, ${t.route}): ${t.findings.join('; ')}`);
  }
  for (const k of report.keyboard) {
    if (k.error !== undefined) {
      failures.push(
        `the keyboard sample of ${k.route} at ${String(k.width)} was not taken: ${k.error}`,
      );
    } else failures.push(...keyboardFailures(k));
  }
  if (report.writes.length > 0) {
    failures.push(
      `the harness caused ${String(report.writes.length)} writes: ${examples(report.writes)}`,
    );
  }
  const wide = measured.filter((e) => e.overflowX);
  if (wide.length > 0) {
    listed.push(
      `${String(wide.length)} pages wider than the viewport: ${examples(wide.map(pageName))}`,
    );
  }
  return { failures, listed, partial };
}
