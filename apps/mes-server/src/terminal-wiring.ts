import type { Identity } from './modules/identity/index.ts';
import type { Orders } from './modules/orders/index.ts';
import type { Shifts } from './modules/shifts/index.ts';

// The operator terminal's wiring between modules (#177, #383), factored out of `main.ts` so the
// tests run the same paths: a session that ends (logout, a disabled user, a password change, a new
// login) ends its crew rows; a crew row that ends closes the activity intervals started under it at
// its end; and at start-up the intervals left open while the MES was down are closed.

export interface TerminalWiringLog {
  error(object: object, message: string): void;
}

/** Session ends to crew ends, crew ends to activity closures. */
export function wireTerminal(deps: {
  readonly identity: Pick<Identity, 'onSessionsEnded'>;
  readonly shifts: Pick<Shifts, 'onChange' | 'endCrewForSessions'>;
  readonly orders: Pick<Orders, 'endCrewActivities'>;
  readonly log: TerminalWiringLog;
}): void {
  const { identity, shifts, orders, log } = deps;
  identity.onSessionsEnded((ended) => {
    shifts.endCrewForSessions(ended.ids).catch((error: unknown) => {
      log.error({ err: error }, 'ending the crew rows of ended sessions failed');
    });
  });
  shifts.onChange((change) => {
    if (change.type !== 'crew' || change.event !== 'ended') return;
    // The intervals started under this row (#366), whatever the clocks say, at its end (#383).
    orders.endCrewActivities(change.crew).catch((error: unknown) => {
      log.error({ err: error }, 'closing the activities of an ended crew row failed');
    });
  });
}

/**
 * At start-up, before the API: one crew check and the orphan sweep (#177, #383), so intervals
 * whose crew row ended while the MES was down (or whose notice was lost) close at that row's end.
 * Returns the operations touched.
 */
export async function closeOrphansAtStart(
  shifts: Pick<Shifts, 'crewCheck'>,
  orders: Pick<Orders, 'endOrphanedActivities'>,
): Promise<number> {
  // `readAt` (database time, read before the rows) matters only for the crew-check sweep: here the
  // API isn't attached yet, so no sign-on or start can fall between it and the rows' read.
  return orders.endOrphanedActivities(await shifts.crewCheck());
}
