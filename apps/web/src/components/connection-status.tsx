import { useLiveConnection } from '../live/live-context.tsx';

/** The dot beside the word, on the tokens (UX-1b, #316): the word carries the state. */
const TEXT = {
  open: { label: 'Live', dot: 'bg-ok-border' },
  connecting: { label: 'Connecting…', dot: 'bg-warn-solid' },
  reconnecting: { label: 'Reconnecting…', dot: 'bg-warn-solid' },
  stopped: { label: 'Offline', dot: 'bg-alarm-border' },
} as const;

/**
 * The live connection's state, announced politely when it changes. On a narrow top bar the words
 * shorten with an ellipsis before anything wraps (the full text stays in the title).
 */
export function ConnectionStatus() {
  const { status, attempt } = useLiveConnection();
  const { label, dot } = TEXT[status];
  const text = `${label}${status === 'reconnecting' && attempt > 1 ? ` (attempt ${String(attempt)})` : ''}`;
  return (
    <p
      role="status"
      data-testid="connection-status"
      data-status={status}
      className="flex min-w-0 items-center gap-2 whitespace-nowrap text-sm"
    >
      <span
        aria-hidden="true"
        className={`inline-block size-2.5 shrink-0 rounded-full ${dot} ${status === 'open' ? '' : 'motion-safe:animate-pulse'}`}
      />
      <span className="truncate" title={text}>
        {text}
      </span>
    </p>
  );
}
