import { Link, type LinkProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useHeadingFocus } from '../heading-focus.ts';
import { usePageTitle } from './use-page-title.ts';

/**
 * The one page header (UX-1b, #316; design system 3.3, G-06):
 *
 * ```
 * ‹ Back label                                                   (optional)
 * Title  [status badges]                              [secondary] [Primary]
 * One-line description, max 90 characters.            (optional)
 * [meta: key facts as "label value · label value"]   (optional)
 * ──────────────────────────────────────────────────────────────────────────
 * [filter bar: label + control pairs inline, wraps; right-aligned summary]   (optional)
 * ```
 *
 * The title is the page's `h1`, focused after a navigation (`useHeadingFocus`), and names the
 * document ("<title> · ShopFloor Twin", G-05) through `usePageTitle`; `documentTitle` gives that
 * text when the title is not plain text (an id in `<Code>`). At most one primary action; below
 * `md` the actions wrap under the title, full width.
 */

export interface PageHeaderBack {
  /** The parent's name, without the "‹ " (one rule, G-06): "All orders", "Plant overview". */
  readonly label: string;
  readonly link: LinkProps;
}

export interface PageHeaderProps {
  readonly title: ReactNode;
  /** The document title's page part; the title itself when that is a string. */
  readonly documentTitle?: string;
  /** The `h1`'s id, for a section that is labelled by it. */
  readonly id?: string;
  /** `dashboard` (overview, OEE, alarm KPIs) has the larger title; lists and details `default`. */
  readonly size?: 'default' | 'dashboard';
  readonly back?: PageHeaderBack;
  /** Badges beside the title (status, finality). */
  readonly status?: ReactNode;
  /** The page's actions, right of the title from `md`. */
  readonly actions?: ReactNode;
  /** One line, at most 90 characters. */
  readonly description?: ReactNode;
  /** Key facts as "label value · label value". */
  readonly meta?: ReactNode;
  /** The filter bar under the rule: label and control pairs inline. */
  readonly filters?: ReactNode;
  /** The result summary, right-aligned on the filter row from `md`. */
  readonly summary?: ReactNode;
  readonly testId?: string;
}

/**
 * Only the exact URL, search included, is "active": a back link points at a parent, so it never is.
 * Shared with the other back links (`NotFound`'s, a detail page's while it loads).
 */
export const BACK_LINK_ACTIVE = { exact: true, includeSearch: true } as const;

/**
 * The way back to the parent ("‹ All orders", 3.3), one element for every page: the header's, and
 * a detail page's while it loads (no `h1` yet). Never marked as the current page (the router's
 * fuzzy match would otherwise mark "‹ All orders" on an order); not printed (the shift report's
 * A4).
 */
export function BackLink({
  back,
  className = '',
  testId,
}: {
  readonly back: PageHeaderBack;
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <p className={`text-sm print:hidden ${className}`.trim()}>
      <Link
        {...back.link}
        activeOptions={BACK_LINK_ACTIVE}
        className="text-link underline-offset-4 hover:underline"
        data-testid={testId}
      >
        ‹ {back.label}
      </Link>
    </p>
  );
}

const TITLE_SIZE = { default: 'text-xl', dashboard: 'text-2xl' } as const;

export function PageHeader({
  title,
  documentTitle,
  id,
  size = 'default',
  back,
  status,
  actions,
  description,
  meta,
  filters,
  summary,
  testId,
}: PageHeaderProps) {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle(documentTitle ?? (typeof title === 'string' ? title : undefined));
  const hasFilterRow = filters !== undefined || summary !== undefined;
  return (
    // A `div`, not a `header`: the top bar is the page's one banner.
    <div data-testid={testId} className="mb-6">
      <div className="border-b border-line-subtle pb-4">
        {back ? <BackLink back={back} className="mb-1" /> : null}
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h1
              ref={heading}
              id={id}
              tabIndex={-1}
              className={`${TITLE_SIZE[size]} min-w-0 font-semibold text-ink`}
            >
              {title}
            </h1>
            {status}
          </div>
          {actions === undefined ? null : (
            <div className="flex w-full flex-wrap gap-2 *:max-md:flex-1 md:w-auto md:shrink-0 md:justify-end">
              {actions}
            </div>
          )}
        </div>
        {description === undefined ? null : (
          <p className="mt-1 max-w-[90ch] text-sm text-ink-secondary">{description}</p>
        )}
        {meta === undefined ? null : <div className="mt-2 text-sm text-ink">{meta}</div>}
      </div>
      {hasFilterRow ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          {filters}
          {summary === undefined ? null : (
            <div className="text-sm text-ink-secondary md:ml-auto">{summary}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
