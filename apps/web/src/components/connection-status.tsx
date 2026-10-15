import { useLiveConnection } from '../live/live-context.tsx';

const TEXT = {
  open: { label: 'Live', dot: 'bg-emerald-600' },
  connecting: { label: 'Connecting…', dot: 'bg-amber-500' },
  reconnecting: { label: 'Reconnecting…', dot: 'bg-amber-500' },
  stopped: { label: 'Offline', dot: 'bg-red-600' },
} as const;

/** The live connection's state, announced politely when it changes. */
export function ConnectionStatus() {
  const { status, attempt } = useLiveConnection();
  const { label, dot } = TEXT[status];
  return (
    <p
      role="status"
      data-testid="connection-status"
      data-status={status}
      className="flex items-center gap-2 text-sm"
    >
      <span
        aria-hidden="true"
        className={`inline-block size-2.5 rounded-full ${dot} ${status === 'open' ? '' : 'motion-safe:animate-pulse'}`}
      />
      <span>
        {label}
        {status === 'reconnecting' && attempt > 1 ? ` (attempt ${String(attempt)})` : ''}
      </span>
    </p>
  );
}
