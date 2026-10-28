import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/render-app.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * While a detail page reads its subject it shows only the way back and a skeleton (no `h1` yet).
 * That way back is the header's `BackLink`, so it is never announced as the current page under
 * its parent (#372 review, #339): the router's fuzzy match marked these hand-rolled links
 * `aria-current="page"` for as long as the read took.
 */
describe('a detail page while it loads', () => {
  it.each([
    ['/equipment/cnc-01', '‹ Plant overview', '/'],
    ['/orders/PO-2610-303', '‹ All orders', '/orders'],
    ['/quality/holds/0f0e0d0c-0b0a-4900-8800-000000000001', '‹ All holds', '/quality/holds'],
    ['/quality/spc/leak-rate', '‹ SPC charts', '/quality/spc'],
    ['/shifts/2026-10-12/A', '‹ Shift reports', '/shifts'],
    ['/trace/serials/VB-100-000042', '‹ Traceability', '/trace'],
  ])('%s has its way back, not marked current', async (path, name, href) => {
    // Nothing answers: every read stays pending.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    await renderApp(path);
    const back = await screen.findByRole('link', { name });
    expect(back.getAttribute('href')).toBe(href);
    expect(back.hasAttribute('aria-current')).toBe(false);
    expect(back.closest('p')?.className).toContain('print:hidden');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
});
