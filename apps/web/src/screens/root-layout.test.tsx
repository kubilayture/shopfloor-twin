import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EQUIPMENT, PLANT, fakeFetch, json, sessionOf } from '../test/fixtures.ts';
import { network, resetNetwork } from '../test/network.ts';
import { renderApp, settle } from '../test/render-app.tsx';
import { formatPlantTime } from '../domain/time.ts';
import { NAV_GROUPS, navCurrent } from './root-layout.tsx';

/** The app shell (UX-1b, #316; design system 3.2). */

const api = {
  '/api/v1/equipment': () => json({ equipment: EQUIPMENT }),
  '/api/v1/plant': () => json(PLANT),
};

/** `matchMedia` for the side nav's `xl` query: `wide` is at least 1280 px. */
function stubWidth(wide: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return wide;
    },
    media: '(min-width: 80rem)',
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return {
    resize(next: boolean) {
      wide = next;
      for (const listener of listeners) listener();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetNetwork();
});

const nav = () => screen.getByRole('navigation', { name: 'Screens' });
const groupHeadings = () =>
  within(nav())
    .queryAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent);

describe('the side nav (G-01, G-02)', () => {
  it('groups the screens by job under real headings, each list labelled by its heading', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    await renderApp('/', { session: sessionOf(['supervisor', 'admin']) });
    expect(groupHeadings()).toEqual(['Monitor', 'Production', 'Quality', 'Admin']);
    const lists = within(nav()).getAllByRole('list');
    const texts = lists.map((list) => ({
      label: list.getAttribute('aria-labelledby'),
      links: within(list)
        .getAllByRole('link')
        .map((link) => link.textContent),
    }));
    expect(texts).toEqual([
      {
        label: 'nav-group-monitor',
        links: ['Overview', 'Alarms', 'Alarm KPIs', 'OEE'],
      },
      {
        label: 'nav-group-production',
        links: ['Orders', 'Downtime coding', 'Shift reports', 'Terminal'],
      },
      { label: 'nav-group-quality', links: ['SPC', 'Holds', 'Traceability'] },
      { label: 'nav-group-admin', links: ['Users', 'Console'] },
    ]);
    for (const list of lists) {
      const heading = document.getElementById(list.getAttribute('aria-labelledby') ?? '');
      expect(heading?.tagName).toBe('H2');
      expect(within(nav()).getByRole('list', { name: heading?.textContent ?? '' })).toBe(list);
    }
    // Every link keeps its test id (the specs click them).
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        expect(screen.getByTestId(`nav-${item.id}`).getAttribute('href')).toBe(item.to);
      }
    }
  });

  it('shows only the links a role may use and hides an empty group', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    const operator = await renderApp('/', { session: sessionOf(['operator']) });
    expect(groupHeadings()).toEqual(['Monitor', 'Production', 'Quality']);
    expect(screen.getByTestId('nav-terminal')).toBeTruthy();
    expect(screen.queryByTestId('nav-console')).toBeNull();
    expect(screen.queryByTestId('nav-users')).toBeNull();
    operator.unmount();

    const quality = await renderApp('/', { session: sessionOf(['quality']) });
    expect(groupHeadings()).toEqual(['Monitor', 'Production', 'Quality']);
    expect(screen.queryByTestId('nav-terminal')).toBeNull();
    quality.unmount();

    await renderApp('/', { session: sessionOf(['admin']) });
    expect(groupHeadings()).toEqual(['Monitor', 'Production', 'Quality', 'Admin']);
    expect(screen.getByTestId('nav-users')).toBeTruthy();
    expect(screen.getByTestId('nav-console')).toBeTruthy();
  });
});

describe('the active link (G-03)', () => {
  const item = (id: string) => {
    const found = NAV_GROUPS.flatMap((group) => group.items).find((entry) => entry.id === id);
    if (!found) throw new Error(id);
    return found;
  };

  it('is the page on its route and "true" on every route under it', () => {
    expect(navCurrent(item('orders'), '/orders')).toBe('page');
    expect(navCurrent(item('orders'), '/orders/')).toBe('page');
    expect(navCurrent(item('orders'), '/orders/PO-2610-303')).toBe('true');
    expect(navCurrent(item('orders'), '/ordersx')).toBeUndefined();
    expect(navCurrent(item('overview'), '/')).toBe('page');
    expect(navCurrent(item('overview'), '/equipment/cnc-01')).toBe('true');
    expect(navCurrent(item('overview'), '/orders')).toBeUndefined();
    expect(navCurrent(item('shifts'), '/shifts/2026-10-12/early')).toBe('true');
    expect(navCurrent(item('trace'), '/trace/serials/VB-1')).toBe('true');
    expect(navCurrent(item('spc'), '/quality/spc/7')).toBe('true');
    expect(navCurrent(item('holds'), '/quality/holds/new')).toBe('true');
    expect(navCurrent(item('spc'), '/quality/holds')).toBeUndefined();
    // Alarms and Alarm KPIs are told apart.
    expect(navCurrent(item('alarms'), '/alarms')).toBe('page');
    expect(navCurrent(item('alarms'), '/alarms/kpi')).toBeUndefined();
    expect(navCurrent(item('alarm-kpi'), '/alarms/kpi')).toBe('page');
    expect(navCurrent(item('alarm-kpi'), '/alarms')).toBeUndefined();
  });

  it('marks the link of a detail page and only that one, with the active look', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    await renderApp('/orders/PO-2610-303');
    const orders = screen.getByTestId('nav-orders');
    expect(orders.getAttribute('aria-current')).toBe('true');
    expect(orders.className).toContain('bg-nav-active');
    expect(orders.className).toContain('text-nav-active-ink');
    expect(orders.className).toContain('before:bg-nav-active-bar');
    const marked = within(nav())
      .getAllByRole('link')
      .filter((link) => link.hasAttribute('aria-current'));
    expect(marked).toEqual([orders]);
    expect(screen.getByTestId('nav-overview').className).not.toContain('bg-nav-active');
  });

  it('marks Alarm KPIs, not Alarms, on /alarms/kpi', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    await renderApp('/alarms/kpi');
    expect(screen.getByTestId('nav-alarm-kpi').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('nav-alarms').hasAttribute('aria-current')).toBe(false);
    expect(screen.getByTestId('nav-alarms').className).not.toContain('bg-nav-active');
  });
});

describe('the top bar (G-01, G-04)', () => {
  it('is one row: the name only (the roles in its title), the clock, the status and Log out', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    const app = await renderApp('/', { session: sessionOf(['operator', 'quality']) });
    await app.open();
    const banner = screen.getByRole('banner');
    expect(banner.className).toContain('h-12');
    expect(banner.className).not.toContain('flex-wrap');
    expect(within(banner).getByTestId('signed-in-user').textContent).toBe('ayse');
    const account = within(banner).getByTestId('nav-account');
    expect(account.getAttribute('href')).toBe('/account');
    expect(account.getAttribute('title')).toBe('Operator, Quality');
    expect(banner.textContent).not.toContain('Operator');
    expect(within(banner).getByRole('button', { name: 'Log out' })).toBe(
      screen.getByTestId('logout'),
    );
    expect(within(banner).getByTestId('connection-status').dataset.status).toBe('open');
    // The navigation is not in the top bar any more.
    expect(within(banner).queryByTestId('nav-overview')).toBeNull();
  });

  it('keeps the plant clock’s time element and its "Gebze plant time" words', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    const app = await renderApp('/');
    await app.open();
    const clock = screen.getByTestId('plant-clock');
    await waitFor(() => {
      expect(clock.querySelector('time')).not.toBeNull();
    });
    expect(clock.textContent).toContain('Gebze plant time: ');
    const time = clock.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe(PLANT.clock.watermark);
    // The whole plant time is the element's text and title; the date shows from `sm`.
    expect(time?.textContent).toBe(formatPlantTime(PLANT.clock.watermark));
    expect(time?.getAttribute('title')).toBe(time?.textContent);
    expect(time?.querySelector('span')?.className).toBe('hidden sm:inline');
    // The prefix is for screen readers only below `lg`.
    expect(clock.querySelector('span')?.className).toMatch(/^sr-only .*lg:not-sr-only/);
  });
});

describe('the nav drawer below xl', () => {
  it('opens from the menu button, takes the focus, and closes on Escape with the focus back', async () => {
    stubWidth(false);
    vi.stubGlobal('fetch', fakeFetch(api));
    await renderApp('/');
    const menu = screen.getByRole('button', { name: 'Menu' });
    const drawer = nav();
    expect(menu.getAttribute('aria-controls')).toBe(drawer.id);
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(drawer.hasAttribute('inert')).toBe(true);
    expect(drawer.className).toContain('-translate-x-full');

    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(drawer.hasAttribute('inert')).toBe(false);
    expect(drawer.className).not.toContain('-translate-x-full');
    expect(document.activeElement).toBe(
      within(drawer).getByRole('button', { name: 'Close the navigation' }),
    );
    // The rest of the page is inert while it is open: every focusable element outside the drawer,
    // the skip link before it included, so Tab and Shift+Tab stay in the drawer.
    expect(screen.getByRole('banner').hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('link', { name: 'Skip to content' }).hasAttribute('inert')).toBe(true);
    const focusable = [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [tabindex]',
      ),
    ].filter((element) => !drawer.contains(element));
    expect(focusable.length).toBeGreaterThan(5);
    expect(focusable.filter((element) => element.closest('[inert]') === null)).toEqual([]);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(drawer.hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('banner').hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('link', { name: 'Skip to content' }).hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(menu);
  });

  it('keeps the offline alert announced while the drawer is open', async () => {
    stubWidth(false);
    const net = network(fakeFetch(api));
    vi.stubGlobal('fetch', net.fetch);
    const app = await renderApp('/');
    await app.open();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    await net.cut();
    const bar = screen.getByTestId('offline-bar');
    expect(bar.getAttribute('role')).toBe('alert');
    expect(bar.closest('[inert]')).toBeNull();
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(true);
    await net.restore();
  });

  it('locks the page scroll while open, and frees it on close, widening and unmount', async () => {
    const width = stubWidth(false);
    vi.stubGlobal('fetch', fakeFetch(api));
    const view = await renderApp('/');
    const root = document.documentElement;
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(nav().className).toContain('overscroll-contain');
    expect(root.hasAttribute('data-nav-open')).toBe(false);

    fireEvent.click(menu);
    expect(root.hasAttribute('data-nav-open')).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(root.hasAttribute('data-nav-open')).toBe(false);

    fireEvent.click(menu);
    expect(root.hasAttribute('data-nav-open')).toBe(true);
    await settle(() => {
      width.resize(true);
    });
    expect(root.hasAttribute('data-nav-open')).toBe(false);
    await settle(() => {
      width.resize(false);
    });

    fireEvent.click(menu);
    expect(root.hasAttribute('data-nav-open')).toBe(true);
    view.unmount();
    expect(root.hasAttribute('data-nav-open')).toBe(false);
  });

  it('holds the body where the page was while open and scrolls back on close, not after a link (iOS)', async () => {
    stubWidth(false);
    vi.stubGlobal('fetch', fakeFetch(api));
    const app = await renderApp('/');
    const root = document.documentElement;
    const scrollTo = vi.spyOn(window, 'scrollTo');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 640 });
    try {
      const menu = screen.getByRole('button', { name: 'Menu' });
      expect(screen.queryByTestId('nav-backdrop')).toBeNull();
      fireEvent.click(menu);
      // The fixed body (`html[data-nav-open] body` in index.css) sits where the page was.
      expect(root.style.getPropertyValue('--nav-lock-top')).toBe('-640px');
      expect(screen.getByTestId('nav-backdrop').className).toContain('touch-none');
      scrollTo.mockClear();
      const focus = vi.spyOn(menu, 'focus');
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(root.style.getPropertyValue('--nav-lock-top')).toBe('');
      expect(scrollTo).toHaveBeenCalledWith({ top: 640, behavior: 'instant' });
      // The focus goes back to the menu button without scrolling the page up to it.
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(document.activeElement).toBe(menu);

      // A followed link: the new page keeps the router's scroll, not the old page's position.
      fireEvent.click(menu);
      scrollTo.mockClear();
      await settle(() => {
        fireEvent.click(screen.getByTestId('nav-orders'));
      });
      await waitFor(() => {
        expect(app.history.location.pathname).toBe('/orders');
      });
      expect(root.hasAttribute('data-nav-open')).toBe(false);
      expect(root.style.getPropertyValue('--nav-lock-top')).toBe('');
      expect(scrollTo).not.toHaveBeenCalledWith({ top: 640, behavior: 'instant' });
    } finally {
      Reflect.deleteProperty(window, 'scrollY');
    }
  });

  it('restores the scroll position only on the same page and query: another view starts at the top', async () => {
    stubWidth(false);
    vi.stubGlobal('fetch', fakeFetch(api));
    const app = await renderApp('/alarms?view=history');
    const scrollTo = vi.spyOn(window, 'scrollTo');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 600 });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
      scrollTo.mockClear();
      // The nav's Alarms link: the same pathname, another query (the nav ignores the search).
      await settle(() => {
        fireEvent.click(screen.getByTestId('nav-alarms'));
      });
      await waitFor(() => {
        expect(app.history.location.search).toBe('');
      });
      expect(app.history.location.pathname).toBe('/alarms');
      expect(document.documentElement.hasAttribute('data-nav-open')).toBe(false);
      expect(scrollTo).not.toHaveBeenCalledWith({ top: 600, behavior: 'instant' });
    } finally {
      Reflect.deleteProperty(window, 'scrollY');
    }
  });

  it("keeps the scrollbar's place while the drawer locks the page (no sideways shift)", () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'index.css'), 'utf8');
    const rule = /html\[data-nav-open\] \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/overflow: hidden;/);
    expect(rule).toMatch(/scrollbar-gutter: stable;/);
  });

  it('gives the focus to the menu button when the layout narrows under a focused nav link', async () => {
    const width = stubWidth(true);
    vi.stubGlobal('fetch', fakeFetch(api));
    await renderApp('/');
    const link = screen.getByTestId('nav-orders');
    link.focus();
    expect(document.activeElement).toBe(link);
    await settle(() => {
      width.resize(false);
    });
    expect(nav().hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Menu' }));

    // Focus elsewhere stays where it is.
    await settle(() => {
      width.resize(true);
    });
    const account = screen.getByTestId('nav-account');
    account.focus();
    await settle(() => {
      width.resize(false);
    });
    expect(document.activeElement).toBe(account);
  });

  it('closes by the backdrop, by its close button and by following a link', async () => {
    stubWidth(false);
    vi.stubGlobal('fetch', fakeFetch(api));
    const app = await renderApp('/');
    const menu = screen.getByRole('button', { name: 'Menu' });

    fireEvent.click(menu);
    fireEvent.click(screen.getByTestId('nav-backdrop'));
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('nav-backdrop')).toBeNull();
    expect(document.activeElement).toBe(menu);

    fireEvent.click(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Close the navigation' }));
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);

    // The link of the page already shown closes it too, the focus back on the menu button.
    fireEvent.click(menu);
    fireEvent.click(screen.getByTestId('nav-overview'));
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);

    fireEvent.click(menu);
    await settle(() => {
      fireEvent.click(screen.getByTestId('nav-orders'));
    });
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/orders');
    });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(nav().hasAttribute('inert')).toBe(true);
    // The new page's heading takes the focus, not the menu button.
    expect(document.activeElement).not.toBe(menu);
  });

  it('is the side nav from xl: never inert, and an open drawer closes when the window widens', async () => {
    const width = stubWidth(false);
    vi.stubGlobal('fetch', fakeFetch(api));
    await renderApp('/');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(nav().hasAttribute('inert')).toBe(false);
    await settle(() => {
      width.resize(true);
    });
    expect(nav().hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.queryByTestId('nav-backdrop')).toBeNull();
    expect(screen.getByRole('banner').hasAttribute('inert')).toBe(false);
    await settle(() => {
      width.resize(false);
    });
    expect(nav().hasAttribute('inert')).toBe(true);
  });
});

describe('the side nav column from xl (#335 review)', () => {
  it('spans the whole page height under the nav, in its colour, out of the accessibility tree', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    await renderApp('/');
    const column = screen.getByTestId('nav-column');
    const classes = column.className.split(' ');
    expect(classes).toEqual(
      expect.arrayContaining([
        'absolute',
        'inset-y-0',
        'left-0',
        'w-58',
        'bg-nav',
        'hidden',
        'xl:block',
      ]),
    );
    expect(column.getAttribute('aria-hidden')).toBe('true');
    expect(column.childElementCount).toBe(0);
    // Positioned against the shell's root, which grows with the page (not the viewport).
    expect(column.parentElement?.className.split(' ')).toEqual(
      expect.arrayContaining(['relative', 'min-h-screen']),
    );
    expect(column.parentElement).toBe(screen.getByRole('banner').parentElement);
  });
});

describe('print', () => {
  it('hides the shell and drops the nav offset', async () => {
    vi.stubGlobal('fetch', fakeFetch(api));
    await renderApp('/');
    expect(screen.getByRole('banner').className).toContain('print:hidden');
    expect(nav().className).toContain('print:hidden');
    const main = screen.getByRole('main');
    expect(main.className).toContain('print:p-0');
    expect(main.parentElement?.className).toContain('xl:pl-58');
    expect(main.parentElement?.className).toContain('print:pl-0');
  });
});

describe('the session check (SessionPending)', () => {
  it('shows a minimal top bar while the session is read, and why it failed with a retry', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        ...api,
        '/api/v1/session': () =>
          fail ? Promise.reject(new TypeError('Failed to fetch')) : json(sessionOf()),
      }),
    );
    await renderApp('/', { session: 'fetch' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The MES cannot be reached to check your session.');
    const banner = screen.getByRole('banner');
    expect(banner.textContent).toBe('ShopFloor Twin');
    expect(banner.dataset.surface).toBe('dark');
    expect(screen.queryByRole('navigation', { name: 'Screens' })).toBeNull();
    expect(screen.queryByTestId('signed-in-user')).toBeNull();
    fail = false;
    await settle(() => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    });
    expect(await screen.findByTestId('signed-in-user')).toBeTruthy();
    expect(screen.queryByText('The MES cannot be reached to check your session.')).toBeNull();
  });
});
