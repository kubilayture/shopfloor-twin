import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../router.tsx';
import { EQUIPMENT, PLANT, fakeFetch, json, sessionOf } from '../test/fixtures.ts';
import { renderApp } from '../test/render-app.tsx';
import { NOT_FOUND_TITLE, routeTitle } from './titles.ts';

/** G-05 (WCAG 2.4.2): every route names the document "<page> · ShopFloor Twin" (UX-1b, #316). */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every route, a path to it and the document title it gives. */
const ROUTES: readonly (readonly [route: string, path: string, title: string])[] = [
  ['/', '/', 'Plant overview'],
  ['/equipment/$id', '/equipment/cnc-01', 'Machine cnc-01'],
  ['/oee', '/oee', 'OEE'],
  ['/downtime', '/downtime', 'Downtime coding'],
  ['/alarms', '/alarms', 'Alarms'],
  ['/alarms/kpi', '/alarms/kpi', 'Alarm KPIs'],
  ['/shifts', '/shifts', 'Shift reports'],
  ['/shifts/$date/$shift', '/shifts/2026-10-12/early', 'Shift report 2026-10-12 early'],
  ['/orders', '/orders', 'Production orders'],
  ['/orders/$id', '/orders/PO-2610-303', 'Order PO-2610-303'],
  ['/login', '/login', 'Log in'],
  ['/account', '/account', 'Account'],
  ['/admin/users', '/admin/users', 'Users'],
  ['/terminal', '/terminal', 'Operator terminal'],
  ['/terminal/$workCenter', '/terminal/cell-m1', 'Terminal cell-m1'],
  ['/trace', '/trace', 'Traceability'],
  ['/trace/serials/$serial', '/trace/serials/VB-100-000042', 'Serial VB-100-000042'],
  ['/trace/lots/$lot', '/trace/lots/SK1-2610-01', 'Lot SK1-2610-01'],
  ['/trace/cartons/$carton', '/trace/cartons/PO-0900-C03', 'Carton PO-0900-C03'],
  ['/quality/spc', '/quality/spc', 'SPC charts'],
  ['/quality/spc/$characteristic', '/quality/spc/7', 'Characteristic 7'],
  ['/quality/holds', '/quality/holds', 'Quality holds'],
  ['/quality/holds/new', '/quality/holds/new', 'Open a quality hold'],
  ['/quality/holds/$id', '/quality/holds/12', 'Hold 12'],
  ['/console', '/console', 'Simulation console'],
];

describe('route titles', () => {
  it('are given for every route of the app, and the list above walks them all', () => {
    const routes = Object.values(createAppRouter().routesById).filter(
      (route) => !route.isRoot,
    ) as readonly { fullPath: string; options: { staticData?: { title?: unknown } } }[];
    const paths = routes.map((route) => route.fullPath).sort();
    expect(paths).toEqual(ROUTES.map(([route]) => route).sort());
    for (const route of routes) {
      expect(route.options.staticData?.title, route.fullPath).toBeDefined();
    }
  });

  it('are made from the deepest titled match, with its params', () => {
    expect(routeTitle([])).toBeUndefined();
    expect(routeTitle([{}, { staticData: { title: 'OEE' } }])).toBe('OEE');
    expect(
      routeTitle([
        { staticData: { title: 'Outer' } },
        { staticData: { title: ({ id }) => `Order ${id ?? ''}` }, params: { id: 'PO-1' } },
      ]),
    ).toBe('Order PO-1');
    expect(routeTitle([{ staticData: { title: ({ id }) => `Order ${id ?? ''}` } }])).toBe('Order');
    // Only the root matched: the router's not-found.
    expect(routeTitle([{ staticData: {} }])).toBe(NOT_FOUND_TITLE);
  });

  it('name the document on every route, as each renders', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/api/v1/equipment': () => json({ equipment: EQUIPMENT }),
        '/api/v1/plant': () => json(PLANT),
      }),
    );
    const admin = sessionOf(['supervisor', 'quality', 'admin']);
    for (const [, path, title] of ROUTES) {
      const view = await renderApp(path, { session: path === '/login' ? null : admin });
      await waitFor(() => {
        expect(document.title, path).toBe(`${title} · ShopFloor Twin`);
      });
      view.unmount();
    }
    const unknown = await renderApp('/no/such/page', { session: admin });
    await waitFor(() => {
      expect(document.title).toBe('Page not found · ShopFloor Twin');
    });
    unknown.unmount();
  });
});
