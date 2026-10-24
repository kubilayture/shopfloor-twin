import { useId, type ReactNode } from 'react';

/**
 * A page section (UX-1b, #316; design system 3.4): a heading with an optional status badge beside
 * it, a one-line description and actions on the right, then the content. A region named by its
 * heading. `level` nests sections: an `h2` (`text-lg`, 32 px apart), an `h3` (`text-base`, 24 px)
 * or an `h4` (`text-sm`, 16 px); none above the first section among its siblings.
 */

/** Heading size and spacing per level; written out in full for Tailwind's scanner. */
const LEVEL = {
  2: { heading: 'text-lg', gap: 'mt-8 first-of-type:mt-0', head: 'mb-3' },
  3: { heading: 'text-base', gap: 'mt-6 first-of-type:mt-0', head: 'mb-2' },
  4: { heading: 'text-sm', gap: 'mt-4 first-of-type:mt-0', head: 'mb-2' },
} as const;

export interface SectionProps {
  readonly title: ReactNode;
  /** The heading level: 2 (the default) for a page's sections, 3 and 4 for sections inside one. */
  readonly level?: 2 | 3 | 4;
  /** The heading's id; generated when absent. */
  readonly id?: string;
  readonly description?: ReactNode;
  /** A badge beside the title (the section's finality). */
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  readonly testId?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Section({
  title,
  level = 2,
  id,
  description,
  status,
  actions,
  testId,
  className,
  children,
}: SectionProps) {
  const generated = useId();
  const headingId = id ?? generated;
  const look = LEVEL[level];
  const Heading = level === 2 ? 'h2' : level === 3 ? 'h3' : 'h4';
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={`${look.gap}${className ? ` ${className}` : ''}`}
    >
      <div className={`${look.head} flex flex-wrap items-start justify-between gap-2`}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Heading id={headingId} className={`${look.heading} font-semibold text-ink`}>
              {title}
            </Heading>
            {status}
          </div>
          {description === undefined ? null : (
            <p className="mt-0.5 text-sm text-ink-secondary">{description}</p>
          )}
        </div>
        {actions === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {children}
    </section>
  );
}
