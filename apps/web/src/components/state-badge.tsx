import { NO_DATA, stateStyle } from '../domain/states.ts';

/**
 * A state as colour and text. `data-state` carries the raw state (`no-data` when the equipment
 * never reported) for tests and tools; people read the label.
 */
export function StateBadge({
  state,
  testId,
  size = 'md',
}: {
  state: string | undefined;
  testId?: string;
  size?: 'md' | 'lg';
}) {
  const style = state === undefined ? NO_DATA : stateStyle(state);
  const sizing = size === 'lg' ? 'px-3 py-1 text-base' : 'px-2 py-0.5 text-sm';
  return (
    <span
      data-testid={testId}
      data-state={state ?? 'no-data'}
      className={`inline-block rounded font-semibold motion-safe:transition-colors ${sizing} ${style.className}`}
    >
      {style.label}
    </span>
  );
}
