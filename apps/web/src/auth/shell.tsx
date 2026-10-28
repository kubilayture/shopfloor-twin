import type { SessionDto } from '@shopfloor/contracts/mes-api';
import { Navigate, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { serverClockOffsetMs } from '../api/client.ts';
import { Button } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { PRODUCT_NAME, useRouteTitle } from '../components/ui/use-page-title.ts';
import { routeTitle } from '../routes/titles.ts';
import { LoginForm } from '../screens/login.tsx';
import { RootLayout } from '../screens/root-layout.tsx';
import { useAuth, type LostSession } from './auth.tsx';
import {
  ACTIVITY_EVENTS,
  ACTIVITY_STORAGE_KEY,
  IDLE_WARNING_MS,
  KEEPALIVE_MS,
  idleDeadline,
  storeActivity,
  storedActivity,
} from './idle.ts';
import { IdleWarning, useLockTitle } from './idle-warning.tsx';
import { isLogin, safeRedirect } from './redirect.ts';

/**
 * Every route but `/login` needs a session whose password needs no change (#170): without one the
 * app goes to `/login` and comes back to the page afterwards. A session lost while the page holds
 * unsaved input keeps the page mounted (inert, covered) under a login for the same user, so no
 * draft is silently dropped. A work center's terminal screen (#177) stands alone: it signs its
 * operators on itself and never keeps one operator's page for the next.
 */
export function Shell() {
  // Every route names the document (G-05), the standalone ones too.
  useRouteTitle(useRouterState({ select: (state) => routeTitle(state.matches) }));
  // By the matched route, not the location: during a navigation the location changes before the
  // matches, and the outlet must never render a protected screen without the check.
  const standalone = useRouterState({
    select: (state) =>
      state.matches.some(
        (match) => match.routeId === '/login' || match.routeId === '/terminal/$workCenter',
      ),
  });
  if (standalone) return <Outlet />;
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

/**
 * While the session is read: the top bar with the product name only (nothing of the signed-in
 * shell before the session is known), and the check or why it failed in `main`.
 */
function SessionPending({ error }: { readonly error: unknown }) {
  const auth = useAuth();
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="flex h-12 items-center bg-topbar px-4 text-topbar-ink" data-surface="dark">
        <span className="text-base font-semibold">{PRODUCT_NAME}</span>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-md px-4 py-16">
        {error ? (
          <Callout
            tone="alarm"
            role="alert"
            title="The MES cannot be reached to check your session."
          >
            <Button
              className="mt-1"
              onClick={() => {
                void auth.refresh().catch(() => undefined);
              }}
            >
              Try again
            </Button>
          </Callout>
        ) : (
          <p role="status" className="text-sm text-ink-secondary">
            Checking your session…
          </p>
        )}
      </main>
    </div>
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
export function IdleWatch({ session }: { readonly session: SessionDto }) {
  const auth = useAuth();
  const { refresh, idleEnded } = auth;
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
    // Ends the session at the MES too, as a logout does (#390 review L3).
    if (over) idleEnded();
  }, [over, idleEnded]);

  if (!warning) return null;
  return (
    <IdleWarning
      absolute={deadline.absolute}
      left={left}
      onStay={() => {
        stay.current();
      }}
      onLogOut={() => {
        void auth.logOut();
      }}
    />
  );
}

/**
 * Over a page with unsaved input whose session is gone: log in again as the same user and carry
 * on, or give the input up and log in as someone else (a shared screen must never send one user's
 * input as another's). The page shows through the backdrop (G-32, #317), inert, so the user sees
 * what they log in again to send; the tab's title says what is asked.
 */
function Relogin({ lost }: { readonly lost: LostSession }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const href = useRouterState({ select: (state) => state.location.href });
  const titleId = useId();
  useLockTitle();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="relogin"
      // See-through (G-32, #352 M1): the page stays visible and inert, so the person sees the input
      // they log in again to send; "Log in as someone else" discards it before anyone else can.
      className="fixed inset-0 z-lock flex items-start justify-center overflow-y-auto bg-backdrop px-4 py-16"
    >
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-6 text-ink shadow-elevation-3">
        <h1 id={titleId} className="text-xl font-bold">
          {lost.reason === 'idle' ? 'Logged out after a while without use' : 'Your session ended'}
        </h1>
        <p className="mt-2 text-sm text-ink-secondary">
          What you entered on this page is kept. Log in again as{' '}
          <span className="font-semibold">{lost.username}</span> to carry on, then send it.
        </p>
        <LoginForm
          className="mt-4"
          fixedUsername={lost.username}
          onLoggedIn={(session) => {
            auth.loggedIn(session);
          }}
        />
        <button
          type="button"
          data-testid="relogin-other"
          className="mt-4 min-h-6 text-sm text-link underline underline-offset-4"
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
