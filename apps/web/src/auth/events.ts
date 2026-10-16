import { PROBLEM_TYPES } from '@shopfloor/contracts/mes-api';
import { ApiError } from '../api/client.ts';

/**
 * What a refused request says about the session (ADR-0026): `ended`, a 401 (no session, or one
 * that ended or expired); `password`, a 403 that asks for a password change first.
 */
export type AuthSignal = 'ended' | 'password';

export function authSignalOf(error: unknown): AuthSignal | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.status === 401) return 'ended';
  if (error.status === 403 && error.problem?.type === PROBLEM_TYPES.passwordChangeRequired) {
    return 'password';
  }
  return undefined;
}

/**
 * Where the query and mutation caches report a request the MES refused for its session, so the
 * app can go to its login (#170). One per app (`createQueryClient`); the auth provider listens.
 */
export class AuthEvents {
  readonly #listeners = new Set<(signal: AuthSignal) => void>();

  /** Reports an error if it is about the session; anything else is ignored. */
  report(error: unknown): void {
    const signal = authSignalOf(error);
    if (signal === undefined) return;
    for (const listener of this.#listeners) listener(signal);
  }

  listen(listener: (signal: AuthSignal) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

const eventsOf = new WeakMap<object, AuthEvents>();

/** Binds the `AuthEvents` a query client reports to (`createQueryClient`). */
export function bindAuthEvents(client: object, events: AuthEvents): void {
  eventsOf.set(client, events);
}

/** The `AuthEvents` a query client reports to (`createQueryClient` binds one; else a fresh one). */
export function authEventsFor(client: object): AuthEvents {
  let events = eventsOf.get(client);
  if (!events) {
    events = new AuthEvents();
    eventsOf.set(client, events);
  }
  return events;
}
