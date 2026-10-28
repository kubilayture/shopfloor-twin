import type { ReactNode } from 'react';
import type { DataAttributes } from './badge.tsx';

/**
 * Key facts (UX-1c, #315; design system 3.4): a `dl` in a fixed number of columns per breakpoint
 * (1 / 2 / 4 by default; `compact`, 2 / 4, for short facts) that flows by column, so the reading
 * order never changes with the width.
 * A fact with no value (`detail` null or undefined) is left out; where its absence is the
 * information, the caller passes it as a `Missing` with the reason, which is kept.
 */

export interface Fact {
  readonly term: ReactNode;
  readonly detail: ReactNode;
  /** A stable key; the term when it is a string. */
  readonly id?: string;
  readonly testId?: string;
  /** `data-*` on the `dd`, the raw markers a test reads beside the figure (#295). */
  readonly detailData?: DataAttributes;
}

/**
 * Columns per breakpoint for each layout: the count from 0, from `sm` and from `xl`. The facts
 * flow by column in every layout (3.4), each column as long as the others or one shorter, so nine
 * facts in four columns are 3, 2, 2, 2 (CSS columns balanced them into 3, 3, 3 and left the
 * fourth empty: the order's header showed three columns, #339).
 */
const LAYOUTS = {
  1: [1, 1, 1],
  2: [1, 2, 2],
  4: [1, 2, 4],
  /** Short facts (a page header's): two columns from the narrowest screen, four from `xl`. */
  compact: [2, 2, 4],
  /** A KPI tile's measures (UX-4b): two columns at every width, as the tile is narrow anyway. */
  tile: [2, 2, 2],
} as const;

/** The grid's columns per breakpoint; each class written out in full for Tailwind. */
const GRID: Readonly<Record<keyof typeof LAYOUTS, string>> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  4: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4',
  compact: 'grid-cols-2 xl:grid-cols-4',
  tile: 'grid-cols-2',
};

/**
 * A fact's place, by breakpoint, from CSS variables its element carries: `--c0`/`--r0` from 0,
 * `--c1`/`--r1` from `sm`, `--c2`/`--r2` from `xl` (set through the CSSOM, which the CSP allows).
 */
const PLACE = [
  '[grid-column:var(--c0)] [grid-row:var(--r0)]',
  'sm:[grid-column:var(--c1)] sm:[grid-row:var(--r1)]',
  'xl:[grid-column:var(--c2)] xl:[grid-row:var(--r2)]',
].join(' ');

/**
 * Where the fact at `index` of `count` goes in `columns` columns, flowing by column: the first
 * `count % columns` columns hold one more. One-based, as CSS grid lines.
 */
export function placeByColumn(
  index: number,
  count: number,
  columns: number,
): { column: number; row: number } {
  const base = Math.floor(count / columns);
  const longer = count % columns;
  let start = 0;
  for (let column = 0; column < columns; column += 1) {
    const length = base + (column < longer ? 1 : 0);
    if (index < start + length) return { column: column + 1, row: index - start + 1 };
    start += length;
  }
  return { column: 1, row: index + 1 };
}

export function DescriptionList({
  facts,
  columns = 4,
  label,
  testId,
}: {
  readonly facts: readonly Fact[];
  readonly columns?: keyof typeof LAYOUTS;
  /** The list's accessible name, when the section heading does not give it. */
  readonly label?: string;
  readonly testId?: string;
}) {
  const shown = facts.filter((fact) => fact.detail !== null && fact.detail !== undefined);
  const counts = LAYOUTS[columns];
  return (
    <dl data-testid={testId} aria-label={label} className={`grid ${GRID[columns]} gap-x-6 text-sm`}>
      {shown.map((fact, index) => {
        const place: Record<string, string> = {};
        counts.forEach((count, breakpoint) => {
          const at = placeByColumn(index, shown.length, count);
          place[`--c${String(breakpoint)}`] = String(at.column);
          place[`--r${String(breakpoint)}`] = String(at.row);
        });
        return (
          <div
            key={fact.id ?? (typeof fact.term === 'string' ? fact.term : String(index))}
            data-testid={fact.testId}
            className={`mb-3 ${PLACE}`}
            style={place}
          >
            <dt className="text-xs font-medium text-ink-secondary">{fact.term}</dt>
            <dd {...fact.detailData} className="mt-0.5 text-ink">
              {fact.detail}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
