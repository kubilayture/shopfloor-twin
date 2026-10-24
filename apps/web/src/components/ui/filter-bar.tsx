import type { ReactNode } from 'react';
import type { DataAttributes } from './badge.tsx';

/**
 * A list's filters (UX-1d2, #319; design system 3.3): label and control pairs (`inline` fields:
 * `Shift [select]`) 12 px apart, wrapping; the result summary ("4 records, 0 uncoded") on the same
 * row, right-aligned, from `md`, and on a line of its own below `md`. A named group, so a screen reader
 * hears "Filters" before the controls. Filters change the list, never the page (WCAG 3.2.2).
 */
export interface FilterBarProps extends DataAttributes {
  /** The group's accessible name; "Filters" by default. */
  readonly label?: string | undefined;
  /** The result summary, right-aligned on the same row from `md`. */
  readonly summary?: ReactNode | undefined;
  readonly className?: string | undefined;
  /** The inline fields. */
  readonly children: ReactNode;
}

export function FilterBar({
  label = 'Filters',
  summary,
  className,
  children,
  ...data
}: FilterBarProps) {
  return (
    <div
      {...data}
      role="group"
      aria-label={label}
      className={`flex flex-wrap items-start gap-x-3 gap-y-2${className ? ` ${className}` : ''}`}
    >
      {children}
      {summary === undefined || summary === null ? null : (
        <div className="w-full text-sm text-ink-secondary md:ml-auto md:w-auto md:self-center">
          {summary}
        </div>
      )}
    </div>
  );
}
