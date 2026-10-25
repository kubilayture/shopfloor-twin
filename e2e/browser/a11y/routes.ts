import type { PageState } from '../../src/a11y-report.ts';

/**
 * Every route of the web app (apps/web/src/routes) for the visual and accessibility harness
 * (UX-1g, #321), each with the URL of its data-rich, empty and not-found state where it has one.
 * A detail route's data state needs an id: from `A11Y_IDS` (the reconciliation passes what it
 * knows) or found on the page (the first link of its list), else the combination is skipped and
 * the report says why. Empty states use a period or filter with nothing in it; not-found states an
 * id that cannot exist. A new route adds a row here (`titles.test.tsx` lists the app's routes).
 */

/** The ids a detail route needs, all optional. */
export interface Ids {
  readonly equipment?: string;
  readonly order?: string;
  readonly characteristic?: string;
  readonly hold?: string;
  readonly serial?: string;
  readonly lot?: string;
  readonly carton?: string;
  /** A shift key, `2026-10-12/A`. */
  readonly shift?: string;
  readonly workCenter?: string;
}

export interface RouteSpec {
  /** The id `A11Y_ROUTES` and the report use. */
  readonly id: string;
  /** The router's path pattern. */
  readonly path: string;
  /** Each state's URL; `undefined` when the state needs an id the run doesn't have. */
  readonly states: Partial<Record<PageState, (ids: Ids) => string | undefined>>;
  /** Visited signed out instead of as each role (the login). */
  readonly signedOutOnly?: boolean;
  /** Also visited signed out (the terminal's sign-on screen). */
  readonly signedOut?: boolean;
}

const e = encodeURIComponent;
/** A past Monday the stack never ran: every period view of it is empty. */
const EMPTY_SHIFT = '2020-01-06/A';
const shiftQuery = (ids: Ids) => (ids.shift ? `?shift=${ids.shift}` : '');

export const ROUTES: readonly RouteSpec[] = [
  { id: 'overview', path: '/', states: { data: () => '/' } },
  {
    id: 'machine',
    path: '/equipment/$id',
    states: {
      data: (ids) => (ids.equipment ? `/equipment/${e(ids.equipment)}` : undefined),
      'not-found': () => '/equipment/no-such-machine',
    },
  },
  {
    id: 'oee',
    path: '/oee',
    states: { data: (ids) => `/oee${shiftQuery(ids)}`, empty: () => `/oee?shift=${EMPTY_SHIFT}` },
  },
  {
    id: 'downtime',
    path: '/downtime',
    states: {
      data: (ids) => `/downtime${shiftQuery(ids)}`,
      empty: () => `/downtime?shift=${EMPTY_SHIFT}`,
    },
  },
  {
    id: 'alarms',
    path: '/alarms',
    states: { data: () => '/alarms?view=history', empty: () => '/alarms?view=shelved' },
  },
  {
    id: 'alarm-kpi',
    path: '/alarms/kpi',
    states: {
      data: (ids) => `/alarms/kpi${shiftQuery(ids)}`,
      empty: () => `/alarms/kpi?shift=${EMPTY_SHIFT}`,
    },
  },
  {
    id: 'orders',
    path: '/orders',
    states: { data: () => '/orders', empty: () => '/orders?status=cancelled' },
  },
  {
    id: 'order',
    path: '/orders/$id',
    states: {
      data: (ids) => (ids.order ? `/orders/${e(ids.order)}` : undefined),
      'not-found': () => '/orders/PO-NO-SUCH-ORDER',
    },
  },
  { id: 'spc', path: '/quality/spc', states: { data: () => '/quality/spc' } },
  {
    id: 'spc-chart',
    path: '/quality/spc/$characteristic',
    states: {
      data: (ids) =>
        ids.characteristic ? `/quality/spc/${e(ids.characteristic)}?all=true` : undefined,
      'not-found': () => '/quality/spc/no-such-characteristic',
    },
  },
  {
    id: 'holds',
    path: '/quality/holds',
    states: { data: () => '/quality/holds', empty: () => '/quality/holds?state=rejected' },
  },
  { id: 'hold-new', path: '/quality/holds/new', states: { data: () => '/quality/holds/new' } },
  {
    id: 'hold',
    path: '/quality/holds/$id',
    states: {
      data: (ids) => (ids.hold ? `/quality/holds/${e(ids.hold)}` : undefined),
      'not-found': () => '/quality/holds/00000000-0000-4000-8000-000000000000',
    },
  },
  { id: 'trace', path: '/trace', states: { empty: () => '/trace' } },
  {
    id: 'serial',
    path: '/trace/serials/$serial',
    states: {
      data: (ids) => (ids.serial ? `/trace/serials/${e(ids.serial)}` : undefined),
      'not-found': () => '/trace/serials/NO-SUCH-SERIAL',
    },
  },
  {
    id: 'lot',
    path: '/trace/lots/$lot',
    states: {
      data: (ids) => (ids.lot ? `/trace/lots/${e(ids.lot)}` : undefined),
      'not-found': () => '/trace/lots/NO-SUCH-LOT',
    },
  },
  {
    id: 'carton',
    path: '/trace/cartons/$carton',
    states: {
      data: (ids) => (ids.carton ? `/trace/cartons/${e(ids.carton)}` : undefined),
      'not-found': () => '/trace/cartons/NO-SUCH-CARTON',
    },
  },
  { id: 'shifts', path: '/shifts', states: { data: () => '/shifts' } },
  {
    id: 'shift-report',
    path: '/shifts/$date/$shift',
    states: {
      data: (ids) => (ids.shift ? `/shifts/${ids.shift}` : undefined),
      'not-found': () => `/shifts/${EMPTY_SHIFT}`,
    },
  },
  { id: 'terminal-picker', path: '/terminal', states: { data: () => '/terminal' } },
  {
    id: 'terminal',
    path: '/terminal/$workCenter',
    signedOut: true,
    states: {
      data: (ids) => `/terminal/${e(ids.workCenter ?? 'line-a1')}`,
      'not-found': () => '/terminal/no-such-line',
    },
  },
  { id: 'account', path: '/account', states: { data: () => '/account' } },
  { id: 'users', path: '/admin/users', states: { data: () => '/admin/users' } },
  { id: 'console', path: '/console', states: { data: () => '/console' } },
  { id: 'login', path: '/login', signedOutOnly: true, states: { data: () => '/login' } },
  { id: 'page-not-found', path: '/*', states: { 'not-found': () => '/no-such-page' } },
];

/**
 * Where a missing id is found on the page as the supervisor: the list's first detail link (as
 * `browser/csp` does). `lot` has no list page; the reconciliation passes it.
 */
export const DISCOVERY: readonly {
  readonly id: keyof Ids;
  readonly from: string;
  readonly prefix: string;
}[] = [
  { id: 'equipment', from: '/', prefix: '/equipment/' },
  { id: 'order', from: '/orders', prefix: '/orders/' },
  { id: 'characteristic', from: '/quality/spc', prefix: '/quality/spc/' },
  { id: 'hold', from: '/quality/holds', prefix: '/quality/holds/' },
  { id: 'shift', from: '/shifts', prefix: '/shifts/' },
  { id: 'serial', from: '/trace/lots/$lot', prefix: '/trace/serials/' },
  { id: 'carton', from: '/trace/lots/$lot', prefix: '/trace/cartons/' },
];
