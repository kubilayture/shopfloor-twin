import type { ReactNode } from 'react';

/**
 * Key facts (UX-1c, #315; design system 3.4): a `dl` in a fixed number of columns per breakpoint
 * (1 / 2 / 4 by default; `compact`, 2 / 4, for short facts) that flows by column, so the reading order never changes with the width.
 * A fact with no value (`detail` null or undefined) is left out; where its absence is the
 * information, the caller passes it as a `Missing` with the reason, which is kept.
 */

export interface Fact {
  readonly term: ReactNode;
  readonly detail: ReactNode;
  /** A stable key; the term when it is a string. */
  readonly id?: string;
  readonly testId?: string;
}

const COLUMNS = {
  1: 'columns-1',
  2: 'columns-1 sm:columns-2',
  4: 'columns-1 sm:columns-2 xl:columns-4',
  /** Short facts (a page header's): two columns from the narrowest screen, four from `xl`. */
  compact: 'columns-2 xl:columns-4',
} as const;

export function DescriptionList({
  facts,
  columns = 4,
  label,
  testId,
}: {
  readonly facts: readonly Fact[];
  readonly columns?: keyof typeof COLUMNS;
  /** The list's accessible name, when the section heading does not give it. */
  readonly label?: string;
  readonly testId?: string;
}) {
  const shown = facts.filter((fact) => fact.detail !== null && fact.detail !== undefined);
  return (
    <dl data-testid={testId} aria-label={label} className={`${COLUMNS[columns]} gap-x-6 text-sm`}>
      {shown.map((fact, index) => (
        <div
          key={fact.id ?? (typeof fact.term === 'string' ? fact.term : String(index))}
          data-testid={fact.testId}
          className="mb-3 break-inside-avoid"
        >
          <dt className="text-xs font-medium text-ink-secondary">{fact.term}</dt>
          <dd className="mt-0.5 text-ink">{fact.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
