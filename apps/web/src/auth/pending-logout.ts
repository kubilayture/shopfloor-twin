/**
 * A logout on its way to the MES (#390), kept in this tab's `sessionStorage`. A page left before
 * the logout ended (a reload, a link, a URL typed right after "Log out") cuts it off, and the next
 * page's read of the session could reach the MES first and find the session still live: it would
 * sign the user back in until the logout landed and then say "Your session ended" (the demo's
 * scene 8 flake). The next page of the tab replays the logout before its first read
 * (`finishPendingLogout`), for that session only: the mark holds the session's `createdAt`, and the
 * MES ends the cookie's session only if it is the one created then (`DELETE /session`).
 */
export const LOGOUT_PENDING_KEY = 'shopfloor.logoutPending';

/**
 * A mark older than this is not replayed (a crashed or restored tab, a page that never came
 * back): a logout cut off by a navigation is replayed by the page that navigation opens.
 */
export const LOGOUT_PENDING_MAX_AGE_MS = 60_000;

/**
 * When someone last logged in, in any tab of this browser (`localStorage`, the tabs share the
 * cookie): a mark older than that login is moot, the cookie holds the newer session.
 */
export const LAST_LOGIN_KEY = 'shopfloor.lastLogin';

/** The replay waits at most this long for the MES; the session is read after it either way. */
export const LOGOUT_REPLAY_TIMEOUT_MS = 3_000;

/**
 * A logout of this page waits at most this long for the MES: the login and the reads of the
 * session wait for it, and a MES that hangs must not keep them waiting. The mark stays.
 */
export const LOGOUT_TIMEOUT_MS = 5_000;

interface Mark {
  /** The `createdAt` of the session being logged out. */
  readonly createdAt: string;
  /** When the logout began (this browser's wall clock). */
  readonly at: number;
}

const tab = (): Storage => globalThis.sessionStorage;
const browser = (): Storage => globalThis.localStorage;

/** Marks the logout of the session created at `createdAt` as on its way. Storage may refuse. */
export function markLogout(createdAt: string, now = Date.now()): void {
  try {
    tab().setItem(LOGOUT_PENDING_KEY, JSON.stringify({ createdAt, at: now } satisfies Mark));
  } catch {
    // Private mode or blocked storage: a reload right after a logout may race it, as before.
  }
}

export function clearLogoutMark(): void {
  try {
    tab().removeItem(LOGOUT_PENDING_KEY);
  } catch {
    // nothing was kept either
  }
}

function readMark(): Mark | undefined {
  try {
    const raw = tab().getItem(LOGOUT_PENDING_KEY);
    if (raw === null) return undefined;
    const mark = JSON.parse(raw) as Partial<Mark> | null;
    if (typeof mark?.createdAt === 'string' && typeof mark.at === 'number') {
      return { createdAt: mark.createdAt, at: mark.at };
    }
  } catch {
    // unreadable: dropped below
  }
  clearLogoutMark();
  return undefined;
}

/** A login happened now: every tab's mark from before it is moot. */
export function noteLogin(now = Date.now()): void {
  try {
    browser().setItem(LAST_LOGIN_KEY, String(now));
  } catch {
    // The replay is conditional at the MES anyway.
  }
}

/** The last login in any tab; none if dated after `now` (the clock went back since). */
function lastLogin(now: number): number {
  try {
    const value = Number(browser().getItem(LAST_LOGIN_KEY));
    return Number.isFinite(value) && value <= now ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Replays the logout an earlier page of this tab left on its way, before this page reads the
 * session: only a fresh mark (`LOGOUT_PENDING_MAX_AGE_MS`) with no login since, and only for the
 * session it names. A replay the MES answered drops the mark; one that failed or timed out
 * (`LOGOUT_REPLAY_TIMEOUT_MS`) keeps it, within its age, for the next page to try again.
 */
export async function finishPendingLogout(
  logout: (body: { createdAt: string }, signal: AbortSignal) => Promise<unknown>,
  now = Date.now,
): Promise<void> {
  const mark = readMark();
  if (!mark) return;
  const at = now();
  const age = at - mark.at;
  if (age < 0 || age > LOGOUT_PENDING_MAX_AGE_MS || lastLogin(at) >= mark.at) {
    clearLogoutMark();
    return;
  }
  try {
    await logout({ createdAt: mark.createdAt }, AbortSignal.timeout(LOGOUT_REPLAY_TIMEOUT_MS));
    clearLogoutMark();
  } catch {
    // Kept (bounded by its age): the read that follows may still find the session.
  }
}
