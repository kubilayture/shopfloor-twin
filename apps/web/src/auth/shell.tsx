import type { SessionDto } from '@shopfloor/contracts/mes-api';
import { Navigate, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { serverClockOffsetMs } from '../api/client.ts';
import { logout } from '../api/identity.ts';
import { LoginForm } from '../screens/login.tsx';
import { RootLayout } from '../screens/root-layout.tsx';
import { useAuth, type LostSession } from './auth.tsx';
import {
  ACTIVITY_EVENTS,
  ACTIVITY_STORAGE_KEY,
  IDLE_WARNING_MS,
  KEEPALIVE_MS,
  countdownText,
  idleDeadline,
  storeActivity,
  storedActivity,
} from './idle.ts';
import { isLogin, safeRedirect } from './redirect.ts';

const buttonClass =
  'rounded border border-slate-700 bg-white px-3 py-1 text-sm font-medium text-slate-900 hover:bg-slate-100 disabled:opacity-60';

/**
 * Every route but `/login` needs a session whose password needs no change (#170): without one the
 * app goes to `/login` and comes back to the page afterwards. A session lost while the page holds
 * unsaved input keeps the page mounted (inert, covered) under a login for the same user, so no
 * draft is silently dropped.
 */
export function Shell() {
  // By the matched route, not the location: during a navigation the location changes before the
  // matches, and the outlet must never render a protected screen without the check.
  const login = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === '/login'),
  });
  if (login) return <Outlet />;
  return <Protected />;
}

function Protected() {
  const auth = useAuth();
  const location = useRouterState({ select: (state) => state.location });
  const { session, lost } = auth;
  // On the way to /login (the location moved, the matches not yet): nothing to show or redirect.
  if (isLogin(location.pathname)) return null;
  const href = location.href;
  if (session === undefined) {
    return <SessionPending error={auth.error} />;
  }
  const locked = lost?.keepPage === true && !session;
  if (!locked && (!session || session.user.mustChangePassword)) {
    return (
      <Navigate to="/login" search={{ redirect: safeRedirect(href), reason: auth.ended }} replace />
    );
  }
  return (
    <>
      {/* The same element whether locked or not, so the page's state survives the lock. */}
      <div inert={locked} data-testid="app-page" data-locked={locked}>
        <SignedIn session={session} />
      </div>
      {locked ? <Relogin lost={lost} /> : null}
    </>
  );
}

function SessionPending({ error }: { readonly error: unknown }) {
  const auth = useAuth();
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-slate-900">
      {error ? (
        <div role="alert" className="rounded border border-red-800 bg-red-50 p-3 text-sm">
          <p>The MES cannot be reached to check your session.</p>
          <button
            type="button"
            className={`${buttonClass} mt-2`}
            onClick={() => {
              void auth.refresh().catch(() => undefined);
            }}
          >
            Try again
          </button>
        </div>
      ) : (
        <p role="status">Checking your session…</p>
      )}
    </main>
  );
}

/** The app with a session: the live client runs, and the idle timeout is watched. */
function SignedIn({ session }: { readonly session: SessionDto | null }) {
  const { startLive } = useAuth();
  useEffect(() => {
    if (session) startLive();
  }, [startLive, session]);
  return (
    <>
      <RootLayout />
      {session ? <IdleWatch session={session} /> : null}
    </>
  );
}

/**
 * The idle timeout here (#170): a person's input in any of this browser's tabs counts as use,
 * pushed messages and background refreshes don't (ADR-0026). Two minutes before the end a warning
 * offers to stay; at the end the session is logged out at the MES too.
 */
function IdleWatch({ session }: { readonly session: SessionDto }) {
  const auth = useAuth();
  const { refresh, sessionLost } = auth;
  // The last input and the last keepalive: written by input handlers, read by the 1 s tick.
  const lastActivity = useRef(0);
  const lastKeepalive = useRef(0);
  const stay = useRef<() => void>(() => undefined);
  const [clock, setClock] = useState(() => ({ now: Date.now(), last: Date.now() }));

  useEffect(() => {
    const started = Date.now();
    lastActivity.current = Math.max(started, storedActivity());
    lastKeepalive.current = started;
    const tick = () => {
      setClock({ now: Date.now(), last: lastActivity.current });
    };
    const used = (at: number) => {
      lastActivity.current = Math.max(lastActivity.current, at);
      if (at - lastKeepalive.current >= KEEPALIVE_MS) {
        lastKeepalive.current = at;
        // Counts as use at the MES: a long draft typed without a request keeps the session.
        void refresh().catch(() => undefined);
      }
    };
    let stored = 0;
    const onInput = () => {
      const at = Date.now();
      used(at);
      // At most every 5 s to storage: other tabs of this app see this tab's use.
      if (at - stored > 5_000) {
        stored = at;
        storeActivity(at);
      }
    };
    // Another tab of this app was used: that is use too. Its keepalives move the MES's idle
    // expiry, so this tab reads the session again (throttled) to see the new expiry.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== ACTIVITY_STORAGE_KEY) return;
      const at = Number(event.newValue);
      if (Number.isFinite(at) && at > 0) used(Math.min(at, Date.now()));
    };
    stay.current = () => {
      lastKeepalive.current = 0;
      used(Date.now());
      tick();
    };
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, onInput, { capture: true, passive: true });
    }
    window.addEventListener('storage', onStorage);
    const timer = setInterval(tick, 1_000);
    tick();
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onInput, true);
      window.removeEventListener('storage', onStorage);
      clearInterval(timer);
    };
  }, [refresh]);

  const deadline = idleDeadline(session, clock.last, serverClockOffsetMs());
  const left = deadline.at - clock.now;
  const over = left <= 0;
  const warning = !over && left <= IDLE_WARNING_MS;
  // The warning reads the session once (#170 review M3): the MES's own idle expiry may have
  // moved with requests this tab doesn't see (polling screens, other tabs).
  useEffect(() => {
    if (warning) void refresh().catch(() => undefined);
  }, [warning, refresh]);
  useEffect(() => {
    if (!over) return;
    // Ends the session at the MES too (other tabs then close their sockets with 4401).
    void logout().catch(() => undefined);
    sessionLost('idle');
  }, [over, sessionLost]);

  if (!warning) return null;
  return (
    <div
      role="alert"
      data-testid="idle-warning"
      data-absolute={deadline.absolute}
      className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-amber-700 bg-amber-50 p-4 text-slate-900 print:hidden"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        {deadline.absolute ? (
          <p>
            Your session reaches its 12-hour limit in{' '}
            <span className="font-mono font-semibold tabular-nums">{countdownText(left)}</span>.
            Save what you are working on; you will need to log in again.
          </p>
        ) : (
          <p>
            Nobody has used this screen for a while: you will be logged out in{' '}
            <span className="font-mono font-semibold tabular-nums">{countdownText(left)}</span>.
            Unsaved input stays on the page; you would log in again to send it.
          </p>
        )}
        <div className="flex gap-2">
          {deadline.absolute ? null : (
            <button
              type="button"
              data-testid="stay-signed-in"
              className={buttonClass}
              onClick={() => {
                stay.current();
              }}
            >
              Stay logged in
            </button>
          )}
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              void auth.logOut();
            }}
          >
            Log out now
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Over a page with unsaved input whose session is gone: log in again as the same user and carry
 * on, or give the input up and log in as someone else (a shared screen must never send one user's
 * input as another's).
 */
function Relogin({ lost }: { readonly lost: LostSession }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const href = useRouterState({ select: (state) => state.location.href });
  const titleId = useId();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="relogin"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-800 px-4 py-16"
    >
      <div className="w-full max-w-md rounded bg-white p-6 text-slate-900 shadow-lg">
        <h1 id={titleId} className="text-xl font-bold">
          {lost.reason === 'idle' ? 'Logged out after a while without use' : 'Your session ended'}
        </h1>
        <p className="mt-2 text-sm">
          What you entered on this page is kept. Log in again as{' '}
          <span className="font-semibold">{lost.username}</span> to carry on, then send it.
        </p>
        <LoginForm
          fixedUsername={lost.username}
          onLoggedIn={(session) => {
            auth.loggedIn(session);
          }}
        />
        <button
          type="button"
          data-testid="relogin-other"
          className="mt-4 text-sm text-sky-800 underline"
          onClick={() => {
            void auth
              .logOut()
              .then(() => navigate({ to: '/login', search: { redirect: safeRedirect(href) } }));
          }}
        >
          Log in as someone else (what you entered is discarded)
        </button>
      </div>
    </div>
  );
}
