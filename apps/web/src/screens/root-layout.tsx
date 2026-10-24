import { STATES_TOPIC } from '@shopfloor/contracts/mes-api';
import type { Permission } from '@shopfloor/contracts/identity';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { requestHeadingFocus } from '../components/heading-focus.ts';
import { Icon } from '../components/ui/icons.tsx';
import { PRODUCT_NAME } from '../components/ui/use-page-title.ts';
import { usePlantClock } from '../api/queries.ts';
import { useAuth } from '../auth/auth.tsx';
import { rolesText } from '../domain/identity.ts';
import { ConnectionStatus } from '../components/connection-status.tsx';
import { OfflineBar } from '../components/offline-bar.tsx';
import { formatPlantTime } from '../domain/time.ts';
import { useLiveSubscription } from '../live/live-context.tsx';

/**
 * The app shell (UX-1b, #316; design system 3.2): a 48 px top bar, the side nav grouped by job
 * (always open from `xl`, a drawer below it), and `main`.
 */

/** Whether a link is the current page (`page`), an ancestor of it (`true`) or neither. */
export type NavCurrent = 'page' | 'true' | undefined;

interface NavItem {
  readonly id: string;
  readonly to: string;
  readonly label: string;
  /** Shown only to a role that may use it. */
  readonly permission?: Permission;
  /** Routes under another path that belong to this link (the machine pages to the overview). */
  readonly also?: readonly string[];
  /** Routes under this one that are another link's (Alarm KPIs under Alarms). */
  readonly except?: readonly string[];
}

interface NavGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly NavItem[];
}

/** The screens by job (design system 3.2); every link keeps its `nav-<id>` test id and its text. */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'monitor',
    label: 'Monitor',
    items: [
      { id: 'overview', to: '/', label: 'Overview', also: ['/equipment'] },
      { id: 'alarms', to: '/alarms', label: 'Alarms', except: ['/alarms/kpi'] },
      { id: 'alarm-kpi', to: '/alarms/kpi', label: 'Alarm KPIs' },
      { id: 'oee', to: '/oee', label: 'OEE' },
    ],
  },
  {
    id: 'production',
    label: 'Production',
    items: [
      { id: 'orders', to: '/orders', label: 'Orders' },
      { id: 'downtime', to: '/downtime', label: 'Downtime coding' },
      { id: 'shifts', to: '/shifts', label: 'Shift reports' },
      { id: 'terminal', to: '/terminal', label: 'Terminal', permission: 'terminal:operate' },
    ],
  },
  {
    id: 'quality',
    label: 'Quality',
    items: [
      { id: 'spc', to: '/quality/spc', label: 'SPC' },
      { id: 'holds', to: '/quality/holds', label: 'Holds' },
      { id: 'trace', to: '/trace', label: 'Traceability' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    items: [
      { id: 'users', to: '/admin/users', label: 'Users', permission: 'user:admin' },
      // The simulation console (#237): the simulated plant's levers, admin only.
      { id: 'console', to: '/console', label: 'Console', permission: 'sim:control' },
    ],
  },
];

const under = (pathname: string, path: string) =>
  pathname === path || pathname.startsWith(`${path}/`);

/**
 * G-03: a link is active on its route (`aria-current="page"`) and on every route under it
 * (`"true"`), so Orders stays marked on an order's page; Alarms and Alarm KPIs are told apart.
 */
export function navCurrent(item: NavItem, pathname: string): NavCurrent {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === item.to) return 'page';
  if (item.except?.some((other) => under(path, other))) return undefined;
  if (item.to !== '/' && under(path, item.to)) return 'true';
  if (item.also?.some((other) => under(path, other))) return 'true';
  return undefined;
}

/** The side nav sits beside the content from `xl` (1280 px) and is a drawer below it. */
const WIDE_QUERY = '(min-width: 80rem)';

function subscribeWide(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

/** Without `matchMedia` (jsdom) the nav counts as open beside the content, as at 1280. */
const isWide = () =>
  typeof window.matchMedia !== 'function' || window.matchMedia(WIDE_QUERY).matches;

function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, isWide, () => true);
}

/** A control on the dark top bar or nav: light text, `nav-hover` under the pointer. */
const DARK_CONTROL =
  'inline-flex shrink-0 items-center justify-center rounded-md hover:bg-nav-hover motion-safe:transition-colors motion-safe:duration-fast';

/** Who is logged in, the account page and the logout (#170); the roles in the link's title (G-04). */
function UserMenu() {
  const auth = useAuth();
  const user = auth.session?.user;
  if (!user) return null;
  const roles = rolesText(user.roles);
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm md:gap-3" data-testid="user-menu">
      <Link
        to="/account"
        className="flex min-w-0 items-center gap-1.5 underline-offset-4 hover:underline"
        data-testid="nav-account"
        title={roles}
      >
        <Icon name="user" size={16} className="hidden text-nav-heading sm:block" />
        <span className="truncate font-semibold" data-testid="signed-in-user">
          {user.username}
        </span>
      </Link>
      <button
        type="button"
        data-testid="logout"
        className={`${DARK_CONTROL} min-h-8 gap-1.5 border border-line-strong px-2.5 font-medium`}
        onClick={() => {
          void auth.logOut();
        }}
      >
        <Icon name="logout" size={16} className="hidden sm:block" />
        Log out
      </button>
    </div>
  );
}

/**
 * The plant clock (`plant-clock`, its `<time dateTime>` read by the demo walkthrough). Below `lg`
 * the "Gebze plant time:" prefix is for screen readers only, below `sm` the date too.
 */
function PlantClock() {
  const { clock, site } = usePlantClock();
  const full = clock ? formatPlantTime(clock.watermark) : '';
  const cut = full.lastIndexOf(', ');
  return (
    <p
      className="flex shrink-0 items-baseline gap-1 whitespace-nowrap text-sm"
      data-testid="plant-clock"
    >
      <span className="sr-only text-nav-heading lg:not-sr-only">
        {site ? `${site.name} plant time` : 'Plant time'}:{' '}
      </span>
      {clock ? (
        <time
          dateTime={clock.watermark}
          title={full}
          className="font-mono font-semibold tabular-nums"
        >
          {cut > 0 ? (
            <>
              <span className="hidden sm:inline">{full.slice(0, cut + 2)}</span>
              {full.slice(cut + 2)}
            </>
          ) : (
            full
          )}
        </time>
      ) : (
        <span>no data yet</span>
      )}
    </p>
  );
}

/**
 * After the route changes (not on the first load, not when only the search changes, so the range
 * picker keeps its focus), focus moves to `main` at once, as the link that had it is gone, and
 * then to the new screen's heading when it mounts (`useHeadingFocus`). A layout effect, so the
 * request is in place before the new screen's own effects run.
 */
function useFocusOnNavigation(pathname: string) {
  const previous = useRef(pathname);
  useLayoutEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    requestHeadingFocus();
    document.getElementById('main')?.focus();
  }, [pathname]);
}

const NAV_ID = 'app-nav';

const LINK_BASE =
  'relative mx-2 flex min-h-9 items-center rounded-md px-3 text-sm motion-safe:transition-colors motion-safe:duration-fast';
/** `nav-active` with white 600-weight text (9.46:1) and a 3 px `nav-active-bar` on the left. */
const LINK_ACTIVE =
  'bg-nav-active font-semibold text-nav-active-ink before:absolute before:inset-y-1.5 before:left-0 before:w-0.75 before:rounded-full before:bg-nav-active-bar';
const LINK_IDLE = 'text-nav-ink hover:bg-nav-hover';

function SideNav({
  open,
  wide,
  pathname,
  closeRef,
  onClose,
  onNavigate,
}: {
  readonly open: boolean;
  readonly wide: boolean;
  readonly pathname: string;
  readonly closeRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  /** A link was followed; `samePage` when it is the page already shown. */
  readonly onNavigate: (samePage: boolean) => void;
}) {
  const auth = useAuth();
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.permission || auth.can(item.permission)),
  })).filter((group) => group.items.length > 0);
  return (
    <nav
      id={NAV_ID}
      aria-label="Screens"
      data-surface="dark"
      data-open={wide || open}
      // Closed below `xl`: off screen and out of the focus order and the accessibility tree.
      inert={!wide && !open}
      className={[
        'fixed inset-y-0 left-0 z-nav flex w-72 max-w-[85vw] flex-col overflow-y-auto overscroll-contain bg-nav pb-6 text-nav-ink',
        'motion-safe:transition-transform motion-safe:duration-base motion-safe:ease-standard',
        'xl:top-12 xl:w-58 xl:max-w-none xl:translate-x-0 xl:shadow-none xl:transition-none',
        'print:hidden',
        // The shadow only while open: a closed drawer's would show at the left edge.
        open ? 'translate-x-0 shadow-elevation-3' : '-translate-x-full',
      ].join(' ')}
      data-print="hidden"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 pl-4 pr-2 xl:hidden">
        <span className="font-semibold text-topbar-ink">{PRODUCT_NAME}</span>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close the navigation"
          title="Close the navigation"
          className={`${DARK_CONTROL} size-9`}
          onClick={onClose}
        >
          <Icon name="close" size={20} />
        </button>
      </div>
      {groups.map((group) => {
        const headingId = `nav-group-${group.id}`;
        return (
          <div key={group.id} className="pt-4">
            <h2
              id={headingId}
              className="px-5 pb-1 text-xs font-semibold uppercase tracking-wider text-nav-heading"
            >
              {group.label}
            </h2>
            <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const current = navCurrent(item, pathname);
                return (
                  <li key={item.id}>
                    <Link
                      to={item.to}
                      // The router marks the exact route `aria-current="page"`; a route under it
                      // is "true" (G-03).
                      activeOptions={{ exact: true, includeSearch: false }}
                      activeProps={{}}
                      {...(current === 'true' ? { 'aria-current': 'true' as const } : {})}
                      className={`${LINK_BASE} ${current ? LINK_ACTIVE : LINK_IDLE}`}
                      data-testid={`nav-${item.id}`}
                      onClick={() => {
                        if (!wide) onNavigate(current === 'page');
                      }}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function RootLayout() {
  useLiveSubscription(STATES_TOPIC);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useFocusOnNavigation(pathname);
  const wide = useWide();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Whether closing should give the focus back to the menu button (not after following a link:
  // the new page's heading takes it then).
  const returnFocus = useRef(false);
  const drawer = open && !wide;

  // A route change or the wide layout closes the drawer.
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    if (open) setOpen(false);
  }
  if (open && wide) setOpen(false);

  const close = useCallback(() => {
    returnFocus.current = true;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (drawer) {
      closeRef.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      menuRef.current?.focus();
    }
  }, [drawer]);

  // Narrowing to the drawer layout (a resize, a 200 % zoom) with the focus on a nav link: the nav
  // turns inert under it, so the focus goes to the menu button rather than to the page's body. A
  // layout effect: the browser moves a focus out of an inert element only after this commit.
  const wasWide = useRef(wide);
  useLayoutEffect(() => {
    if (
      wasWide.current &&
      !wide &&
      document.getElementById(NAV_ID)?.contains(document.activeElement)
    ) {
      menuRef.current?.focus();
    }
    wasWide.current = wide;
  }, [wide]);

  // The page behind an open drawer does not scroll (`html[data-nav-open]` in `index.css`); undone
  // when it closes, on a widening and on unmount.
  useEffect(() => {
    if (!drawer) return;
    const root = document.documentElement;
    root.dataset.navOpen = '';
    return () => {
      delete root.dataset.navOpen;
    };
  }, [drawer]);

  // Escape anywhere closes the open drawer (the focus is in it, but a click may have moved it).
  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [drawer, close]);

  return (
    <div className="min-h-screen bg-canvas text-ink print:min-h-0 print:bg-surface">
      <a
        href="#main"
        inert={drawer}
        data-surface="dark"
        className="sr-only print:hidden focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-popover focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-ink"
      >
        Skip to content
      </a>
      <header
        className="sticky top-0 z-topbar flex h-12 items-center gap-2 bg-topbar px-2 text-topbar-ink md:gap-4 md:px-4 print:hidden"
        data-print="hidden"
        data-surface="dark"
        inert={drawer}
      >
        <button
          ref={menuRef}
          type="button"
          aria-label="Menu"
          title="Menu"
          aria-expanded={drawer}
          aria-controls={NAV_ID}
          className={`${DARK_CONTROL} size-9 xl:hidden`}
          onClick={() => {
            setOpen(true);
          }}
        >
          <Icon name="menu" size={20} />
        </button>
        <Link
          to="/"
          className="hidden shrink-0 whitespace-nowrap px-1 text-base font-semibold underline-offset-4 hover:underline sm:block xl:w-54 xl:px-2"
        >
          {PRODUCT_NAME}
        </Link>
        <div className="ml-auto flex min-w-0 items-center gap-3 md:gap-5">
          <PlantClock />
          <ConnectionStatus />
          <UserMenu />
        </div>
      </header>
      {drawer ? (
        <div
          aria-hidden="true"
          data-testid="nav-backdrop"
          className="fixed inset-0 z-nav bg-backdrop xl:hidden print:hidden"
          onClick={close}
        />
      ) : null}
      <SideNav
        open={drawer}
        wide={wide}
        pathname={pathname}
        closeRef={closeRef}
        onClose={close}
        onNavigate={(samePage) => {
          // To another page its heading takes the focus; on the same page the menu button does.
          returnFocus.current = samePage;
          setOpen(false);
        }}
      />
      {/* Only `main` is inert under the drawer: the offline alert is still announced. */}
      <div className="xl:pl-58 print:pl-0">
        <OfflineBar />
        <main
          id="main"
          tabIndex={-1}
          inert={drawer}
          className="px-4 py-6 md:px-6 xl:px-8 print:p-0"
        >
          <div className="mx-auto w-full max-w-360 print:max-w-none">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
