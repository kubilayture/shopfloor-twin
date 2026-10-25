import { useId, type ReactNode } from 'react';
import type { Tone } from './tokens.ts';

/**
 * A card (UX-1c, #315; design system 4.3): a white surface with a 1 px `line` border and
 * `radius-lg`, no shadow, for a group of facts or a chart. `status` puts a badge (the finality)
 * beside the title, `actions` top right. `tone` adds a 4 px left bar in the tone's border colour,
 * for abnormal items only.
 *
 * Its role, by `as`: a `div` (the default) with a title is a named group (`role="group"`), so a
 * grid of KPI cards does not flood the landmark list; `section` is a region landmark and
 * `article` an article, each named by its heading, for a card that is a page section or a
 * self-contained item (a machine card). Without a title none is named.
 */

/** Written out in full: Tailwind finds class names in the source. */
export const CARD_TONE_BAR: Readonly<Record<Tone, string>> = {
  neutral: 'border-l-4 border-l-neutral-border',
  info: 'border-l-4 border-l-info-border',
  ok: 'border-l-4 border-l-ok-border',
  warn: 'border-l-4 border-l-warn-border',
  caution: 'border-l-4 border-l-caution-border',
  alarm: 'border-l-4 border-l-alarm-border',
};

export interface CardProps {
  readonly title?: ReactNode;
  /** 2 or 3; 4 for an item card under a level-3 section (a machine card), at `text-base`. */
  readonly headingLevel?: 2 | 3 | 4;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly status?: ReactNode;
  readonly tone?: Tone | undefined;
  readonly padding?: 'compact' | 'default';
  readonly as?: 'section' | 'article' | 'div';
  readonly testId?: string | undefined;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Card({
  title,
  headingLevel = 2,
  description,
  actions,
  status,
  tone,
  padding = 'default',
  as: Element = 'div',
  testId,
  className,
  children,
}: CardProps) {
  const headingId = useId();
  const Heading = headingLevel === 2 ? 'h2' : headingLevel === 3 ? 'h3' : 'h4';
  const hasHeader = title !== undefined || description !== undefined || actions !== undefined;
  return (
    <Element
      data-testid={testId}
      {...(title === undefined
        ? {}
        : Element === 'div'
          ? { role: 'group', 'aria-labelledby': headingId }
          : { 'aria-labelledby': headingId })}
      className={[
        'rounded-lg border border-line bg-surface text-ink',
        padding === 'compact' ? 'p-4' : 'p-5',
        tone ? CARD_TONE_BAR[tone] : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {hasHeader ? (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title === undefined ? null : (
              <div className="flex flex-wrap items-center gap-2">
                <Heading
                  id={headingId}
                  className={`${headingLevel === 4 ? 'text-base' : 'text-lg'} font-semibold`}
                >
                  {title}
                </Heading>
                {status}
              </div>
            )}
            {description === undefined ? null : (
              <p className="mt-0.5 text-sm text-ink-secondary">{description}</p>
            )}
          </div>
          {actions === undefined ? null : (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
      ) : null}
      {children}
    </Element>
  );
}
