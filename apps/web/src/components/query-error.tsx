import { useState } from 'react';
import { useOfflineBarShown } from './offline-bar.tsx';
import { ErrorState, isNetworkError } from './ui/error-state.tsx';

/**
 * A failed read with what the MES said (problem details) and a way to try again when that can
 * help: the screens' one error view, on `ErrorState` since UX-1e (#317). A failure to reach the
 * MES while the shell's offline bar is up is quiet (one line, not announced): the bar is the one
 * alert. It stays quiet until its read runs again (the bar has every failed read run again when
 * the connection is back), so the lines do not all turn into alerts at that moment (#352 review
 * M4); a read that fails again with the connection back is loud.
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
  const barShown = useOfflineBarShown();
  const unreachable = isNetworkError(error);
  // The error object that was shown quietly: a new one comes only with the next attempt.
  const [quietFor, setQuietFor] = useState<unknown>(undefined);
  if (barShown && unreachable && quietFor !== error) setQuietFor(error);
  const quiet = unreachable && (barShown || quietFor === error);
  return <ErrorState what={what} error={error} onRetry={onRetry} quiet={quiet} />;
}
