import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { usePlantClock } from '../api/queries.ts';
import { formatClockSeconds } from '../domain/time.ts';
import { useConnectionLost, useLiveConnection } from '../live/live-context.tsx';
import { Icon } from './ui/icons.tsx';

/** How many offline bars are up (one in the shell; none on the terminal's own screen). */
let barsShown = 0;
const barListeners = new Set<() => void>();
function barsChanged(): void {
  for (const listener of barListeners) listener();
}

/**
 * Whether the shell's offline bar is up: the screens' failed reads are quiet only under it, so a
 * screen without the bar (the terminal) keeps its errors loud.
 */
export function useOfflineBarShown(): boolean {
  return useSyncExternalStore(
    (listener) => {
      barListeners.add(listener);
      return () => {
        barListeners.delete(listener);
      };
    },
    () => barsShown > 0,
  );
}

/**
 * Under the top bar while the figures cannot update (#312; design system 4.11): the browser is
 * offline, or, with the browser online, the live connection is lost (#317 after #343: the socket
 * failed to come back, or has been reconnecting for 5 s). Says since when the figures stopped
 * updating, as the plant clock read when the connection went, and goes when it is back. Offline,
 * writes fail meanwhile where each form shows a refused one, and are not sent later by themselves.
 *
 * One `role="alert"` per outage: the screens' failed reads stay quiet meanwhile (`QueryError`).
 * When the connection is back, the active reads that failed are read again at once (#352 review
 * M4): the live cache does that after a dropped connection, and the bar after a first connect that
 * hung, so the quiet lines never stand until the next poll.
 */
export function OfflineBar() {
  const connection = useLiveConnection();
  const { clock } = usePlantClock();
  const lost = useConnectionLost();
  const queryClient = useQueryClient();
  const wasLost = useRef(false);
  /** The outage dropped a connection (or the browser went offline), not only a hung connect. */
  const dropped = useRef(false);
  useEffect(() => {
    if (lost && (connection.status === 'reconnecting' || connection.status === 'stopped')) {
      dropped.current = true;
    }
  }, [lost, connection.status]);
  useEffect(() => {
    // After a dropped connection the live cache reads every REST query again when the socket is
    // back (and TanStack Query on the browser's `online`): only a first connect that hung and then
    // got through is left, and its failed reads are run here, once each (#352 review).
    if (wasLost.current && !lost && !dropped.current) {
      void queryClient.refetchQueries({
        type: 'active',
        predicate: (query) => query.state.status === 'error',
      });
    }
    if (!lost) dropped.current = false;
    wasLost.current = lost;
  }, [lost, queryClient]);
  useEffect(() => {
    if (!lost) return undefined;
    barsShown += 1;
    barsChanged();
    return () => {
      barsShown -= 1;
      barsChanged();
    };
  }, [lost]);
  // The plant clock when the connection went, kept while lost whatever arrives late.
  const [since, setSince] = useState<{ readonly at: string | null } | null>(null);
  if (lost && since === null) setSince({ at: clock?.watermark ?? null });
  if (!lost && since !== null) setSince(null);
  if (!lost) return null;
  const at = since ? since.at : (clock?.watermark ?? null);
  const offline = connection.offline;
  return (
    <div
      role="alert"
      data-testid="offline-bar"
      data-reason={offline ? 'offline' : 'connection'}
      className="border-b-2 border-warn-border bg-warn-soft text-warn-ink print:hidden"
      data-print="hidden"
    >
      <p className="mx-auto flex max-w-360 items-start gap-2 px-4 py-2 text-sm md:px-6 xl:px-8">
        <Icon name="alert" size={16} className="mt-0.5" />
        <span>
          <span className="font-semibold">{offline ? 'Offline:' : 'Connection lost:'}</span>{' '}
          {at === null ? (
            `the figures on this page stopped updating when the ${offline ? 'network' : 'connection'} was lost.`
          ) : (
            <>
              the figures on this page stopped updating at{' '}
              <time dateTime={at} className="font-mono tabular-nums">
                {formatClockSeconds(at)}
              </time>{' '}
              plant time.
            </>
          )}{' '}
          {offline
            ? 'They update again when the network is back; what you send meanwhile is not saved.'
            : 'Reconnecting to the MES; they update again once it answers.'}
        </span>
      </p>
    </div>
  );
}
