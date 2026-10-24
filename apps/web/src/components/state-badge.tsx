import { NO_DATA, STALE_TEXT, stateStyle, type Staleness } from '../domain/states.ts';
import { Badge, BadgeFrame } from './ui/badge.tsx';

type StateBadgeSize = 'md' | 'lg';

/**
 * A machine state as its word on the state's colours, with its glyph (design system 2.4).
 * `data-state` carries the raw state (`no-data` when the equipment never reported) for tests and
 * tools; people read the label. With `stale`, the Stale tag stands beside it.
 */
export function StateBadge({
  state,
  testId,
  size = 'md',
  stale,
  staleTestId,
}: {
  readonly state: string | undefined;
  readonly testId?: string;
  readonly size?: StateBadgeSize;
  /** Why the shown state may be out of date: adds the `StaleTag` beside the badge. */
  readonly stale?: Staleness;
  readonly staleTestId?: string;
}) {
  const style = state === undefined ? NO_DATA : stateStyle(state);
  const badge = (
    <BadgeFrame
      data-testid={testId}
      data-state={state ?? 'no-data'}
      colors={style.className}
      icon={style.icon}
      size={size}
      className="motion-safe:transition-colors motion-safe:duration-fast"
    >
      {style.label}
    </BadgeFrame>
  );
  if (stale === undefined) return badge;
  return (
    <>
      {badge}
      <StaleTag reason={stale} size={size} testId={staleTestId} />
    </>
  );
}

/**
 * The state beside it may be out of date (design system 2.4): a `warn` tag with a clock and the
 * full reason as visible text, exactly `STALE_TEXT` ("Stale: live connection lost"), never only
 * in a tooltip. Its solid border keeps it apart from the dashed Setup and No data badges.
 */
export function StaleTag({
  reason,
  testId,
  size = 'md',
}: {
  readonly reason: NonNullable<Staleness>;
  readonly testId?: string | undefined;
  readonly size?: StateBadgeSize;
}) {
  return (
    <Badge tone="warn" variant="soft" icon="clock" size={size} data-testid={testId}>
      {STALE_TEXT[reason]}
    </Badge>
  );
}
