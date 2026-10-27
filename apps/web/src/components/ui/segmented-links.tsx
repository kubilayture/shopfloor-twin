import { Link, type LinkOptions } from '@tanstack/react-router';

/**
 * A range or view switch that changes the URL (UX-1e, #317; design system 4.13): a row of real
 * links in a `role="group"` frame named by `label`, the current one `aria-current="page"` with the
 * selected look (`accent` fill, white text 7.56:1), the others secondary. The machine detail's
 * "Last hour", "Last 8 h", "Last 24 h" are its first use (M-04; `machine-detail.test.tsx` reads
 * them by role link). A switch that leaves the URL alone is a `Tabs` or a toggle group instead.
 */
export interface SegmentedLink {
  readonly key: string;
  readonly label: string;
  readonly to: NonNullable<LinkOptions['to']>;
  readonly params?: NonNullable<LinkOptions['params']>;
  readonly search?: NonNullable<LinkOptions['search']>;
  readonly testId?: string | undefined;
}

export interface SegmentedLinksProps {
  readonly label: string;
  readonly items: readonly SegmentedLink[];
  /** The key of the current item. */
  readonly current: string;
  readonly testId?: string | undefined;
}

const ITEM =
  'inline-flex min-h-8 items-center px-3 text-[0.8125rem] font-medium first:rounded-l-md last:rounded-r-md ' +
  'border-l border-line-strong first:border-l-0 motion-safe:transition-colors motion-safe:duration-fast';

export function SegmentedLinks({ label, items, current, testId }: SegmentedLinksProps) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className="inline-flex flex-wrap rounded-md border border-line-strong bg-surface"
    >
      {items.map((item) => {
        const active = item.key === current;
        return (
          <Link
            key={item.key}
            to={item.to}
            {...(item.params === undefined ? {} : { params: item.params })}
            {...(item.search === undefined ? {} : { search: item.search })}
            data-testid={item.testId}
            // `current` alone says which item is current: the router's own match would mark a link
            // whose search is a subset of the URL's (`{}` under `?from=…`) as the page too (#332).
            activeOptions={{ exact: true, includeSearch: true }}
            aria-current={active ? 'page' : undefined}
            className={`${ITEM} ${active ? 'bg-accent font-semibold text-on-accent' : 'text-ink hover:bg-surface-hover'}`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
