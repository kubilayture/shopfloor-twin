import { SESSION_IDLE_MS } from '@shopfloor/contracts/identity';
import type { SessionDto } from '@shopfloor/contracts/mes-api';

/** The warning shows this long before the session ends here (#170). */
export const IDLE_WARNING_MS = 2 * 60_000;

/**
 * A person's input reads the session again (counting as use at the MES) at most this often, so a
 * user who types a long draft without sending it keeps the session (the MES never counts pushed
 * messages, ADR-0026).
 */
export const KEEPALIVE_MS = 2 * 60_000;

/** What counts as use here: a person's input, never a pushed message or a background refresh. */
export const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** Shared between this app's tabs, which share the session cookie (a per-browser convenience). */
export const ACTIVITY_STORAGE_KEY = 'shopfloor.lastActivity';

export interface IdleDeadline {
  /** Wall time the session ends at unless used before. */
  readonly at: number;
  /** True when it is the absolute limit (12 h after the login), which no use moves. */
  readonly absolute: boolean;
}

/**
 * When the app ends a session (#170): the idle timeout of its kind (desk 60 min, terminal 15 min)
 * after the last input in any of this browser's tabs, or the absolute expiry, whichever is first.
 */
export function idleDeadline(session: SessionDto, lastActivity: number): IdleDeadline {
  const idle = lastActivity + SESSION_IDLE_MS[session.kind];
  const absolute = Date.parse(session.expiresAt);
  return idle < absolute ? { at: idle, absolute: false } : { at: absolute, absolute: true };
}

/** `m:ss` of a countdown (never negative). */
export function countdownText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The last input any tab recorded (`localStorage` may be missing or refuse: then none). */
export function storedActivity(storage: () => Storage = () => globalThis.localStorage): number {
  try {
    const value = Number(storage().getItem(ACTIVITY_STORAGE_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function storeActivity(
  at: number,
  storage: () => Storage = () => globalThis.localStorage,
): void {
  try {
    storage().setItem(ACTIVITY_STORAGE_KEY, String(at));
  } catch {
    // Private mode or blocked storage: each tab then times out on its own input.
  }
}
