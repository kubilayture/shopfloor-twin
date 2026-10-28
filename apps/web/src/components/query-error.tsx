import { useOfflineBarShown } from './offline-bar.tsx';
import { ErrorState, isNetworkError } from './ui/error-state.tsx';

/**
 * The errors shown quietly while an offline bar was up, wherever they were shown (#394): an error
 * object belongs to one attempt of one read, so it stays quiet until that read runs again, also
 * when it moves between a section's error and the screen's (`ScreenError`) meanwhile.
 */
const shownQuietly = new WeakSet<object>();

/**
 * Whether failed reads are said quietly: each one could not reach the MES while the shell's offline
 * bar is up (the bar is the one alert), or was already said quietly then and has not run again (the
 * bar has every failed read run again when the connection is back, so the lines do not all turn
 * into alerts at that moment, #352 review M4); a read that fails again with the connection back is
 * loud.
 */
export function useQuietErrors(errors: readonly unknown[]): boolean {
  const barShown = useOfflineBarShown();
  if (errors.length === 0 || !errors.every(isNetworkError)) return false;
  // A network error is an `Error` with a status (`isNetworkError`), so an object.
  const objects = errors as readonly object[];
  if (barShown) {
    for (const error of objects) shownQuietly.add(error);
    return true;
  }
  return objects.every((error) => shownQuietly.has(error));
}

/**
 * A failed read with what the MES said (problem details) and a way to try again when that can
 * help: the screens' one error view, on `ErrorState` since UX-1e (#317). A failure to reach the
 * MES while the shell's offline bar is up is quiet (one line, not announced): the bar is the one
 * alert (`useQuietErrors`). Several reads of one screen that failed together are one
 * `ScreenError` (#394).
 */
export function QueryError({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry?: () => void;
}) {
  const quiet = useQuietErrors([error]);
  return <ErrorState what={what} error={error} onRetry={onRetry} quiet={quiet} />;
}
