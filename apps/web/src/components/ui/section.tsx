import { useId, type ReactNode } from 'react';

/**
 * A page section (UX-1b, #316; design system 3.4): an `h2` (`text-lg`) with an optional status
 * badge beside it, a one-line description and actions on the right, then the content. A region
 * named by its heading. Sections stand 32 px apart (`mt-8`, none on the first).
 */
export interface SectionProps {
  readonly title: ReactNode;
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
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={`mt-8 first:mt-0${className ? ` ${className}` : ''}`}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={headingId} className="text-lg font-semibold text-ink">
              {title}
            </h2>
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
