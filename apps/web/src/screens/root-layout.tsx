import { STATES_TOPIC } from '@shopfloor/contracts/mes-api';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useLayoutEffect, useRef } from 'react';
import { requestHeadingFocus, useHeadingFocus } from '../components/heading-focus.ts';
import { usePlantClock } from '../api/queries.ts';
import { useAuth } from '../auth/auth.tsx';
import { rolesText } from '../domain/identity.ts';
import { ConnectionStatus } from '../components/connection-status.tsx';
import { formatPlantTime } from '../domain/time.ts';
import { useLiveSubscription } from '../live/live-context.tsx';

const NAV = [
  { id: 'overview', to: '/', label: 'Overview' },
  { id: 'oee', to: '/oee', label: 'OEE' },
  { id: 'downtime', to: '/downtime', label: 'Downtime coding' },
  { id: 'alarms', to: '/alarms', label: 'Alarms' },
  { id: 'alarm-kpi', to: '/alarms/kpi', label: 'Alarm KPIs' },
  { id: 'shifts', to: '/shifts', label: 'Shift reports' },
  { id: 'orders', to: '/orders', label: 'Orders' },
  { id: 'trace', to: '/trace', label: 'Traceability' },
  { id: 'spc', to: '/quality/spc', label: 'SPC' },
  { id: 'holds', to: '/quality/holds', label: 'Holds' },
] as const;

/** Who is logged in, the account page and the logout (#170). */
function UserMenu() {
  const auth = useAuth();
  const user = auth.session?.user;
  if (!user) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="user-menu">
      <Link
        to="/account"
        className="underline-offset-4 hover:underline"
        data-testid="nav-account"
        title={rolesText(user.roles)}
      >
        <span className="font-semibold" data-testid="signed-in-user">
          {user.username}
        </span>{' '}
        <span className="text-slate-300">({rolesText(user.roles)})</span>
      </Link>
      <button
        type="button"
        data-testid="logout"
        className="rounded border border-slate-400 px-2 py-0.5 hover:bg-slate-800"
        onClick={() => {
          void auth.logOut();
        }}
      >
        Log out
      </button>
    </div>
  );
}

function PlantClock() {
  const { clock, site } = usePlantClock();
  return (
    <p className="text-sm" data-testid="plant-clock">
      <span className="text-slate-300">{site ? `${site.name} plant time` : 'Plant time'}: </span>
      {clock ? (
        <time dateTime={clock.watermark} className="font-mono font-semibold tabular-nums">
          {formatPlantTime(clock.watermark)}
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
function useFocusOnNavigation() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previous = useRef(pathname);
  useLayoutEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    requestHeadingFocus();
    document.getElementById('main')?.focus();
  }, [pathname]);
}

export function RootLayout() {
  useLiveSubscription(STATES_TOPIC);
  useFocusOnNavigation();
  const auth = useAuth();
  const nav = [
    ...NAV,
    ...(auth.can('terminal:operate')
      ? [{ id: 'terminal', to: '/terminal', label: 'Terminal' } as const]
      : []),
    ...(auth.can('user:admin')
      ? [{ id: 'users', to: '/admin/users', label: 'Users' } as const]
      : []),
    // The simulation console (#237): the simulated plant's levers, admin only.
    ...(auth.can('sim:control')
      ? [{ id: 'console', to: '/console', label: 'Console' } as const]
      : []),
  ];
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 print:min-h-0 print:bg-white">
      <a
        href="#main"
        data-surface="dark"
        className="sr-only print:hidden focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-popover focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header
        className="bg-slate-900 text-white print:hidden"
        data-print="hidden"
        data-surface="dark"
      >
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link to="/" className="text-lg font-bold hover:underline">
              ShopFloor Twin <span className="font-normal text-slate-300">MES</span>
            </Link>
            <nav aria-label="Screens">
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {nav.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      activeOptions={{ exact: true, includeSearch: false }}
                      activeProps={{ 'aria-current': 'page', className: 'font-semibold underline' }}
                      className="underline-offset-4 hover:underline"
                      data-testid={`nav-${item.id}`}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <PlantClock />
            <ConnectionStatus />
            <UserMenu />
          </div>
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto max-w-7xl px-4 py-6 focus:outline-none print:max-w-none print:p-0"
      >
        <Outlet />
      </main>
    </div>
  );
}

export function NotFound() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  return (
    <section>
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Page not found
      </h1>
      <p className="mt-2">
        <Link to="/" className="text-sky-800 underline">
          Back to the plant overview
        </Link>
      </p>
    </section>
  );
}
