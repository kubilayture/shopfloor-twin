import { can as rolesCan, type Permission } from '@shopfloor/contracts/identity';
import type { SessionDto } from '@shopfloor/contracts/mes-api';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getSession, logout } from '../api/identity.ts';
import { forgetCharts } from '../api/quality.ts';
import { authEventsFor } from './events.ts';
import { clearLogoutMark, finishPendingLogout, markLogout, noteLogin } from './pending-logout.ts';
import { Restarts } from './restarts.ts';
import { useLiveClient } from '../live/live-context.tsx';

/** The session query: the caller's session, or null without one (ADR-0026, #170). */
export const sessionKey = ['session'] as const;

/** Why a session the app held is gone: ended by the MES (401, 4401) or by the idle timeout here. */
export type LostReason = 'ended' | 'idle';

export interface LostSession {
  readonly username: string;
  /** The session as it was: a kept page still shows what its roles allowed. */
  readonly held: SessionDto;
  readonly reason: LostReason;
  /**
   * The page had unsaved input when the session was lost: it stays mounted under a login for the
   * same user, so nothing typed is lost; otherwise the app goes to `/login` and back.
   */
  readonly keepPage: boolean;
}

/** Unsaved input on the page (a draft): registered by the forms that hold it. */
export class Drafts {
  readonly #open = new Set<symbol>();

  set(id: symbol, dirty: boolean): void {
    if (dirty) this.#open.add(id);
    else this.#open.delete(id);
  }

  any(): boolean {
    return this.#open.size > 0;
  }
}

export interface Auth {
  /** The session; null without one; undefined while it is being read. */
  readonly session: SessionDto | null | undefined;
  /** Why the session could not be read (the MES unreachable), if it could not. */
  readonly error: unknown;
  /** A read of the session failed at least once (it may be retrying): `/login` shows its form. */
  readonly readFailed: boolean;
  readonly lost: LostSession | undefined;
  /** Why the last session of this tab ended, for `/login` to say: lost (above) or logged out. */
  readonly ended: LostReason | 'logout' | undefined;
  /** A logout is still ending the session at the MES: the login waits for it (#170 review L3). */
  readonly loggingOut: boolean;
  readonly drafts: Drafts;
  /** Whether the session's roles hold the permission (`ROLE_PERMISSIONS` of contracts). */
  readonly can: (permission: Permission) => boolean;
  /** A login (or a password change) succeeded with this session. */
  readonly loggedIn: (session: SessionDto) => void;
  /** Ends the session here and at the MES, empties the cache and stops the live client. */
  readonly logOut: () => Promise<void>;
  /** The session is gone (a 401, a 4401 close, or the idle timeout). */
  readonly sessionLost: (reason: LostReason) => void;
  /** The idle timeout here ended the session: lost as `idle`, and logged out at the MES. */
  readonly idleEnded: () => void;
  /** Reads the session again: counts as use at the MES and moves its idle expiry. */
  readonly refresh: () => Promise<void>;
  /**
   * Starts the live client if the cache holds a session that may read (not one that must change
   * its password): a render that still sees a session just logged out never restarts it.
   */
  readonly startLive: () => void;
}

const AuthContext = createContext<Auth | undefined>(undefined);

export function useAuth(): Auth {
  const auth = use(AuthContext);
  if (!auth) throw new Error('useAuth needs an AuthProvider');
  return auth;
}

/** Whether the signed-in user may do this: screens hide what a role lacks; the MES refuses it too. */
export function useCan(permission: Permission): boolean {
  return useAuth().can(permission);
}

/**
 * Marks the component's input as unsaved while `dirty`: if the session ends meanwhile, the page
 * stays mounted under a login for the same user instead of navigating away (#170).
 */
export function useUnsavedDraft(dirty: boolean): void {
  const { drafts } = useAuth();
  const [id] = useState(() => Symbol('draft'));
  useEffect(() => {
    drafts.set(id, dirty);
    return () => {
      drafts.set(id, false);
    };
  }, [drafts, id, dirty]);
}

/**
 * Empties every cached read but the session, and every mutation's state (its variables may hold
 * what the last user typed): another user, or nobody, is next.
 */
function forgetData(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== sessionKey[0] });
  queryClient.getMutationCache().clear();
  // The SPC chart answers kept for `If-None-Match` (#203) go with the cache.
  forgetCharts();
}

/**
 * The browser storage keys of earlier versions that held people's input: `shopfloor.codedBy`, the
 * name typed into the write screens before #170. Removed at start; storage may refuse.
 */
export const LEGACY_STORAGE_KEYS = ['shopfloor.codedBy'] as const;

export function forgetLegacyStorage(storage: () => Storage = () => globalThis.localStorage): void {
  try {
    for (const key of LEGACY_STORAGE_KEYS) storage().removeItem(key);
  } catch {
    // Private mode or blocked storage: nothing was stored either.
  }
}

/** A 4403 close starts the live client again at most this often (UX-7 review). */
export const RESTART_AFTER_4403_MS = 30_000;

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient();
  const live = useLiveClient();
  // The last user who held a session in this tab: a login as anyone else empties the cache.
  const lastUser = useRef<string | undefined>(undefined);
  // Moves with every login and logout: a logout empties the cache only if it is still the last,
  // and a read of the session begun before either is not the session any more.
  const generation = useRef(0);
  // The replay of a logout an earlier page of this tab left on its way, before the first read.
  const replayed = useRef<Promise<void> | undefined>(undefined);
  // The logout this page sent, until the MES answers it.
  const ending = useRef<Promise<void>>(Promise.resolve());
  /**
   * Waits for any logout on its way (#390): a read of the session that reached the MES before the
   * logout's DELETE would find the session still live and sign its user back in.
   */
  const afterLogouts = useCallback(async () => {
    replayed.current ??= finishPendingLogout(logout);
    await replayed.current;
    await ending.current;
  }, []);
  const query = useQuery({
    queryKey: sessionKey,
    queryFn: async ({ signal }) => {
      await afterLogouts();
      const at = generation.current;
      const read = await getSession(signal);
      // A logout or a login meanwhile decides the session: the MES may have answered this read
      // before the logout ended it, or before the login.
      if (generation.current === at) return read;
      return queryClient.getQueryData<SessionDto | null>(sessionKey) ?? null;
    },
    staleTime: Infinity,
    meta: { auth: false },
  });
  const session = query.data;
  const [lost, setLost] = useState<LostSession | undefined>(undefined);
  const [ended, setEnded] = useState<LostReason | 'logout' | undefined>(undefined);
  const [drafts] = useState(() => new Drafts());
  const [loggingOut, setLoggingOut] = useState(false);
  useEffect(() => {
    forgetLegacyStorage();
  }, []);
  useEffect(() => {
    if (session) lastUser.current = session.user.username;
  }, [session]);

  /** When 4403 closes start the live client again (`RESTART_AFTER_4403_MS`, #387). */
  const [restarts] = useState(() => new Restarts(RESTART_AFTER_4403_MS));
  useEffect(
    () => () => {
      restarts.cancel();
    },
    [restarts],
  );

  const startLive = useCallback(() => {
    // A start now (a login, a session read back changed, a 4403's restart) makes one put off moot.
    restarts.cancel();
    const current = queryClient.getQueryData<SessionDto | null>(sessionKey);
    if (current && !current.user.mustChangePassword) live.start();
  }, [queryClient, live, restarts]);

  const sessionLost = useCallback(
    (reason: LostReason) => {
      const current = queryClient.getQueryData<SessionDto | null>(sessionKey);
      if (!current) return;
      restarts.cancel();
      live.stop();
      setLost({ username: current.user.username, held: current, reason, keepPage: drafts.any() });
      setEnded(reason);
      queryClient.setQueryData(sessionKey, null);
    },
    [queryClient, live, drafts, restarts],
  );

  const loggedIn = useCallback(
    (next: SessionDto) => {
      const previous = lastUser.current;
      const sameUser = previous === next.user.username;
      if (!sameUser) forgetData(queryClient);
      lastUser.current = next.user.username;
      generation.current += 1;
      // A logout left on its way, in this tab or another, is moot: the cookie is this session's.
      clearLogoutMark();
      noteLogin();
      queryClient.setQueryData(sessionKey, next);
      setLost(undefined);
      setEnded(undefined);
      if (next.user.mustChangePassword) return;
      startLive();
      // Reads refused while the session was gone are read again.
      if (sameUser) {
        void queryClient.invalidateQueries({
          predicate: (q) => q.queryKey[0] !== sessionKey[0] && q.queryKey[0] !== 'live',
        });
      }
    },
    [queryClient, startLive],
  );

  /**
   * Ends `held` at the MES (a logout, the idle timeout): reads of the session wait for it, a login
   * waits for it (`loggingOut`), and a page left before it ended replays it (`markLogout`).
   */
  const endAtMes = useCallback(async (held: SessionDto | null | undefined) => {
    generation.current += 1;
    if (held) markLogout(held.createdAt);
    setLoggingOut(true);
    const done = logout().then(
      () => {
        clearLogoutMark();
      },
      () => {
        // The cookie may outlive an unreachable MES; the session still ends at its idle expiry.
        // The mark stays (within its age): the next page of the tab tries again.
      },
    );
    ending.current = done;
    await done;
    setLoggingOut(false);
  }, []);

  const logOut = useCallback(async () => {
    // The page goes first (no session: the shell leaves it), then the socket and the cookie.
    const held = queryClient.getQueryData<SessionDto | null>(sessionKey);
    lastUser.current = undefined;
    setLost(undefined);
    setEnded('logout');
    queryClient.setQueryData(sessionKey, null);
    restarts.cancel();
    live.stop();
    const ends = endAtMes(held);
    const mine = generation.current;
    await ends;
    // Only if nobody logged in meanwhile: their reads must stay.
    if (generation.current === mine) forgetData(queryClient);
  }, [queryClient, live, restarts, endAtMes]);

  const idleEnded = useCallback(() => {
    const held = queryClient.getQueryData<SessionDto | null>(sessionKey);
    sessionLost('idle');
    // Ends it at the MES too (other tabs then close their sockets with 4401).
    void endAtMes(held);
  }, [queryClient, sessionLost, endAtMes]);

  const refresh = useCallback(async () => {
    await afterLogouts();
    const at = generation.current;
    const next = await getSession();
    // A logout or a login meanwhile: this answer may predate it (see the session query).
    if (generation.current !== at) return;
    if (next) queryClient.setQueryData(sessionKey, next);
    else sessionLost('ended');
  }, [queryClient, sessionLost, afterLogouts]);

  // Requests the MES refused for the session (query and mutation caches), and the socket's close.
  useEffect(() => {
    const events = authEventsFor(queryClient);
    const stopEvents = events.listen((signal) => {
      // `password` or `forbidden`: the session's roles or its temporary password may have changed
      // (an admin's edit); read it again so the screens show what it may do now.
      if (signal === 'ended') sessionLost('ended');
      else void queryClient.invalidateQueries({ queryKey: sessionKey });
    });
    const stopLive = live.onAuthClose((code) => {
      if (code === 4401) sessionLost('ended');
      else {
        // 4403: the client has stopped; the session is read again, and one that may still read
        // starts it again (`startLive` checks). Here, not in the screens' effects on the session:
        // a session read back unchanged keeps its reference, so those effects would not run
        // (#341 review, UX-7 review M2), and the desk and the terminal would stay "Offline".
        // At most once per `RESTART_AFTER_4403_MS` (`Restarts`): a 4403 inside it puts the
        // restart off to its end, so the client is not started in a loop, nor left stopped.
        // A restart now waits on the session's read: not after an unmount, a logout, a lost
        // session or another start meanwhile (`Restarts.cancel`).
        const again = restarts.refused(startLive);
        const generation = restarts.generation;
        void queryClient.invalidateQueries({ queryKey: sessionKey }).then(() => {
          if (again && restarts.current(generation)) startLive();
        });
      }
    });
    return () => {
      stopEvents();
      stopLive();
    };
  }, [queryClient, live, sessionLost, startLive, restarts]);

  const value = useMemo<Auth>(
    () => ({
      session,
      error: query.error,
      readFailed: query.error !== null || query.failureCount > 0,
      lost,
      ended,
      loggingOut,
      drafts,
      // A page kept under the re-login keeps what its user's roles allowed, so no form unmounts.
      can: (permission) => {
        const held = session ?? (lost?.keepPage ? lost.held : undefined);
        return held ? rolesCan(held.user.roles, permission) : false;
      },
      loggedIn,
      logOut,
      sessionLost,
      idleEnded,
      refresh,
      startLive,
    }),
    [
      session,
      query.error,
      query.failureCount,
      lost,
      ended,
      loggingOut,
      drafts,
      loggedIn,
      logOut,
      sessionLost,
      idleEnded,
      refresh,
      startLive,
    ],
  );
  return <AuthContext value={value}>{children}</AuthContext>;
}
