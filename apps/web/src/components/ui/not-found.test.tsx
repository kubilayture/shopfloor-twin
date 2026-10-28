import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { act, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { Forbidden, NotFound, PageNotFound } from './not-found.tsx';
import { SegmentedLinks } from './segmented-links.tsx';

/** UX-1e (#317): design system 4.11 (NotFound, N-07) and 4.13 (SegmentedLinks), in a router. */
async function routed(ui: () => ReactNode, path = '/') {
  const rootRoute = createRootRoute({ component: ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  await act(async () => {
    await router.load();
  });
  return router;
}

describe('NotFound', () => {
  it('heads the page with the id as asked, says the MES has none, and links back', async () => {
    await routed(() => (
      <NotFound
        kind="order"
        id="PO-NOPE"
        back={{ to: '/orders', label: 'All orders' }}
        testId="nf"
      />
    ));
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Order PO-NOPE');
    expect(heading.querySelector('code')?.textContent).toBe('PO-NOPE');
    expect(heading.tabIndex).toBe(-1);
    const empty = screen.getByTestId('nf');
    expect(within(empty).getByRole('heading', { level: 2 }).textContent).toBe('No order PO-NOPE');
    expect(empty.textContent).toContain('The MES has no order with this id.');
    expect(screen.getByRole('link', { name: '‹ All orders' }).getAttribute('href')).toBe('/orders');
  });

  it('never marks its way back as the current page, under the parent it links to', async () => {
    await routed(
      () => <NotFound kind="order" id="PO-NOPE" back={{ to: '/orders', label: 'All orders' }} />,
      '/orders/PO-NOPE',
    );
    const back = screen.getByRole('link', { name: '‹ All orders' });
    expect(back.getAttribute('href')).toBe('/orders');
    expect(back.hasAttribute('aria-current')).toBe(false);
  });

  it('adds a sentence of why after the one it always says', async () => {
    await routed(() => (
      <NotFound
        kind="carton"
        id="C-9"
        back={{ to: '/trace', label: 'Traceability' }}
        detail="Cartons form once their packing cycles are final."
        testId="nf"
      />
    ));
    expect(screen.getByTestId('nf').textContent).toContain(
      'The MES has no carton with this id. Cartons form once their packing cycles are final.',
    );
  });

  it("is the router's page for an unknown address, naming the address", async () => {
    await routed(() => <PageNotFound />, '/nowhere');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Nothing at this address' })).toBeTruthy();
    expect(screen.getByText('/nowhere').tagName).toBe('CODE');
    expect(screen.getByRole('link', { name: '‹ Plant overview' }).getAttribute('href')).toBe('/');
  });
});

describe('Forbidden', () => {
  it('keeps the sentence and the permission id, announced, with a way back', async () => {
    await routed(() => (
      <Forbidden testId="console-forbidden" permission="sim:control">
        Only an admin drives the simulation
      </Forbidden>
    ));
    const block = screen.getByTestId('console-forbidden');
    expect(block.getAttribute('role')).toBe('alert');
    expect(block.textContent).toContain(
      'Only an admin drives the simulation (permission sim:control).',
    );
    expect(within(block).getByText('sim:control').tagName).toBe('CODE');
    expect(within(block).getByRole('heading', { level: 2 }).textContent).toBe(
      'Not available for your role',
    );
    expect(
      within(block).getByRole('link', { name: 'Back to the plant overview' }).getAttribute('href'),
    ).toBe('/');
    expect(block.querySelector('svg[data-icon="ban"]')).not.toBeNull();
  });
});

describe('SegmentedLinks', () => {
  it('renders real links in a named group, the current one aria-current="page"', async () => {
    await routed(
      () => (
        <SegmentedLinks
          label="Time range"
          current="8h"
          testId="range"
          items={[
            {
              key: '1h',
              label: 'Last hour',
              to: '/equipment/$id',
              params: { id: 'cnc-01' },
              search: { range: '1h' },
            },
            {
              key: '8h',
              label: 'Last 8 h',
              to: '/equipment/$id',
              params: { id: 'cnc-01' },
              search: { range: '8h' },
              testId: 'range-8h',
            },
            { key: 'all', label: 'Overview', to: '/' },
          ]}
        />
      ),
      '/equipment/cnc-01',
    );
    const group = screen.getByRole('group', { name: 'Time range' });
    expect(group.dataset.testid).toBe('range');
    const links = within(group).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Last hour', 'Last 8 h', 'Overview']);
    expect(links[0]?.getAttribute('href')).toBe('/equipment/cnc-01?range=1h');
    expect(links[2]?.getAttribute('href')).toBe('/');
    const current = within(group).getByRole('link', { name: 'Last 8 h' });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.dataset.testid).toBe('range-8h');
    expect(current.className).toContain('bg-accent');
    expect(current.className).toContain('text-on-accent');
    expect(links[0]?.hasAttribute('aria-current')).toBe(false);
    expect(links[0]?.className).not.toContain('bg-accent');
  });

  it('marks only the `current` item, not a link whose search is a subset of the URL’s', async () => {
    await routed(
      () => (
        <SegmentedLinks
          label="Points shown"
          current="range"
          items={[
            {
              key: 'recent',
              label: 'Recent',
              to: '/equipment/$id',
              params: { id: 'cnc-01' },
              search: {},
            },
            {
              key: 'all',
              label: 'All',
              to: '/equipment/$id',
              params: { id: 'cnc-01' },
              search: { range: '24h' },
            },
          ]}
        />
      ),
      '/equipment/cnc-01?range=8h',
    );
    const group = screen.getByRole('group', { name: 'Points shown' });
    expect(within(group).queryAllByRole('link', { current: 'page' })).toEqual([]);
  });
});
