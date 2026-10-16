import { PRIORITY_LABELS, type Priority } from '../domain/alarms.ts';

/** AA-contrast colours; the text label always says the priority (never colour alone). */
const STYLE: Readonly<Record<Priority, string>> = {
  high: 'border-red-800 bg-red-700 text-white',
  medium: 'border-amber-700 bg-amber-200 text-amber-950',
  low: 'border-sky-800 bg-sky-50 text-sky-950',
};

const MARK: Readonly<Record<Priority, string>> = { high: '▲▲', medium: '▲', low: '●' };

export function PriorityBadge({
  priority,
  testId,
}: {
  readonly priority: Priority;
  readonly testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-priority={priority}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 text-xs font-semibold ${STYLE[priority]}`}
    >
      <span aria-hidden="true">{MARK[priority]}</span>
      {PRIORITY_LABELS[priority]}
    </span>
  );
}
