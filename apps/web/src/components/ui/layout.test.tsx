import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { act, render, renderHook, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { requestHeadingFocus } from '../heading-focus.ts';
import { PageHeader } from './page-header.tsx';
import { Section } from './section.tsx';
import { documentTitle, usePageTitle, useRouteTitle } from './use-page-title.ts';

/** The page header, the section and the document title (UX-1b, #316; design system 3.3, 3.4). */

/** Renders `ui` as the page of a one-route router at `/orders/PO-1`, with `/orders` beside it. */
async function renderInRouter(ui: ReactNode) {
  const root = createRootRoute();
  const page = createRoute({
    getParentRoute: () => root,
    path: '/orders/$id',
    component: () => ui,
  });
  const list = createRoute({ getParentRoute: () => root, path: '/orders', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([page, list]),
    history: createMemoryHistory({ initialEntries: ['/orders/PO-1'] }),
  });
  render(<RouterProvider router={router as never} />);
  await act(async () => {
    await router.load();
  });
  return router;
}

describe('documentTitle and usePageTitle (G-05)', () => {
  it('reads "<page> · ShopFloor Twin", the product name alone without a page', () => {
    expect(documentTitle('Alarms')).toBe('Alarms · ShopFloor Twin');
    expect(documentTitle('  Alarms ')).toBe('Alarms · ShopFloor Twin');
    expect(documentTitle(undefined)).toBe('ShopFloor Twin');
    expect(documentTitle(' ')).toBe('ShopFloor Twin');
  });

  it("puts a screen's title over the route's while it is mounted, the newest winning", () => {
    const route = renderHook<undefined, { title: string | undefined }>(
      ({ title }) => {
        useRouteTitle(title);
      },
      { initialProps: { title: 'Machine cnc-01' } },
    );
    expect(document.title).toBe('Machine cnc-01 · ShopFloor Twin');

    const screenTitle = renderHook(
      ({ title }: { title: string }) => {
        usePageTitle(title);
      },
      { initialProps: { title: 'Horizontal machining centre 1' } },
    );
    expect(document.title).toBe('Horizontal machining centre 1 · ShopFloor Twin');
    // The route changing underneath does not override the screen's own title.
    route.rerender({ title: 'Machine cnc-02' });
    expect(document.title).toBe('Horizontal machining centre 1 · ShopFloor Twin');
    screenTitle.rerender({ title: 'Vertical lathe' });
    expect(document.title).toBe('Vertical lathe · ShopFloor Twin');

    const blank = renderHook(() => {
      usePageTitle('  ');
    });
    expect(document.title).toBe('Vertical lathe · ShopFloor Twin');
    blank.unmount();

    screenTitle.unmount();
    expect(document.title).toBe('Machine cnc-02 · ShopFloor Twin');
    route.rerender({ title: undefined });
    expect(document.title).toBe('ShopFloor Twin');
    route.unmount();
  });
});

describe('PageHeader (design system 3.3)', () => {
  it('has the page h1 with its status, actions, description and meta, and names the document', () => {
    render(
      <PageHeader
        id="order-title"
        title="Order PO-1"
        status={<span data-testid="badge">Released</span>}
        actions={<button type="button">Close order</button>}
        description="One line about the page."
        meta={<span>Due Mon 12 Oct, 22:00</span>}
        testId="header"
      />,
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'Order PO-1' });
    expect(heading.id).toBe('order-title');
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(heading.className).toContain('text-xl');
    const header = screen.getByTestId('header');
    expect(header.tagName).toBe('DIV');
    expect(within(header).getByTestId('badge')).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'Close order' })).toBeTruthy();
    expect(header.textContent).toContain('One line about the page.');
    expect(header.textContent).toContain('Due Mon 12 Oct, 22:00');
    expect(document.title).toBe('Order PO-1 · ShopFloor Twin');
    // No filter row without filters.
    expect(header.children).toHaveLength(1);
  });

  it('takes the focus after a navigation, and the larger title on a dashboard', () => {
    requestHeadingFocus();
    render(<PageHeader title="Plant overview" size="dashboard" />);
    const heading = screen.getByRole('heading', { level: 1, name: 'Plant overview' });
    expect(document.activeElement).toBe(heading);
    expect(heading.className).toContain('text-2xl');
  });

  it('names the document by documentTitle when the title is not plain text', () => {
    render(
      <PageHeader
        title={
          <>
            Order <code>PO-1</code>
          </>
        }
        documentTitle="Order PO-1"
      />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Order PO-1');
    expect(document.title).toBe('Order PO-1 · ShopFloor Twin');
  });

  it('puts the filters and the summary under the rule', () => {
    render(
      <PageHeader
        title="Downtime coding"
        filters={<label>Shift</label>}
        summary="4 records, 0 uncoded"
        testId="header"
      />,
    );
    const header = screen.getByTestId('header');
    expect(header.children).toHaveLength(2);
    const filterRow = header.children[1];
    expect(filterRow?.textContent).toBe('Shift4 records, 0 uncoded');
    expect(filterRow?.lastElementChild?.className).toContain('md:ml-auto');
  });

  it('has a back link "‹ <parent>" above the title', async () => {
    await renderInRouter(
      <PageHeader title="Order PO-1" back={{ label: 'All orders', link: { to: '/orders' } }} />,
    );
    const back = screen.getByRole('link', { name: '‹ All orders' });
    expect(back.getAttribute('href')).toBe('/orders');
    // The parent of the page is never the page, whatever the router's fuzzy match says (#332).
    expect(back.hasAttribute('aria-current')).toBe(false);
    expect(
      back.compareDocumentPosition(screen.getByRole('heading', { level: 1 })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('Section (design system 3.4)', () => {
  it('is a region named by its h2, with a description, a status and actions', () => {
    render(
      <Section
        title="Machining"
        id="area-machining"
        description="Six machines."
        status={<span>Final</span>}
        actions={<button type="button">Print</button>}
        testId="section"
      >
        <p>content</p>
      </Section>,
    );
    const region = screen.getByRole('region', { name: 'Machining' });
    expect(region).toBe(screen.getByTestId('section'));
    const heading = within(region).getByRole('heading', { level: 2, name: 'Machining' });
    expect(heading.id).toBe('area-machining');
    expect(heading.className).toContain('text-lg');
    expect(region.textContent).toContain('Six machines.');
    expect(region.textContent).toContain('Final');
    expect(within(region).getByRole('button', { name: 'Print' })).toBeTruthy();
    expect(region.className).toContain('mt-8');
  });

  it('nests by level: an h3 and an h4 with their smaller headings and spacing', () => {
    render(
      <Section title="Machining">
        <Section title="Cell M1" level={3} testId="cell">
          <Section title="Spindle" level={4} testId="spindle">
            <p>content</p>
          </Section>
        </Section>
      </Section>,
    );
    const cell = screen.getByRole('region', { name: 'Cell M1' });
    const h3 = within(cell).getByRole('heading', { level: 3, name: 'Cell M1' });
    expect(h3.className).toContain('text-base');
    expect(cell.className).toContain('mt-6');
    const spindle = screen.getByRole('region', { name: 'Spindle' });
    expect(within(spindle).getByRole('heading', { level: 4 }).className).toContain('text-sm');
    expect(spindle.className).toContain('mt-4');
    expect(screen.getByRole('heading', { level: 2, name: 'Machining' }).className).toContain(
      'text-lg',
    );
  });

  it('labels itself by a generated id without one', () => {
    render(
      <Section title="Lines">
        <p>content</p>
      </Section>,
    );
    const region = screen.getByRole('region', { name: 'Lines' });
    expect(region.getAttribute('aria-labelledby')).toBe(
      within(region).getByRole('heading', { level: 2 }).id,
    );
  });
});
