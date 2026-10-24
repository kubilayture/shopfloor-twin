import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons.tsx';

/**
 * An empty list or section (UX-1e, #317; design system 4.11 and 6.3): a title that says what is
 * empty ("No holds match these filters"), one line of why or what to do, and an action when there
 * is one ("Clear filters"). Never a lone "none". A table with no rows shows this instead of its
 * header row. A test id that marked an empty text moves onto it.
 *
 * `inline` is a line inside a card; `section` a centred block in the section's frame (the
 * default); `page` the block of a page with nothing else to show (not found, no permission),
 * whose title is an `h2` under the page's `h1`.
 */
export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly body?: ReactNode;
  readonly action?: ReactNode;
  readonly icon?: IconName;
  readonly size?: 'inline' | 'section' | 'page';
  readonly testId?: string | undefined;
  readonly role?: 'alert' | 'status';
}

const FRAME = {
  inline: 'flex items-start gap-2 py-3 text-left',
  section: 'flex flex-col items-center gap-2 px-4 py-10 text-center',
  page: 'flex flex-col items-center gap-2 px-4 py-16 text-center',
} as const;

export function EmptyState({
  title,
  body,
  action,
  icon,
  size = 'section',
  testId,
  role,
}: EmptyStateProps) {
  const Title = size === 'page' ? 'h2' : 'p';
  return (
    <div data-testid={testId} data-empty={size} role={role} className={`${FRAME[size]} text-sm`}>
      {icon === undefined ? null : size === 'inline' ? (
        <Icon name={icon} size={16} className="mt-0.5 text-ink-secondary" />
      ) : (
        <span className="mb-1 inline-flex size-10 items-center justify-center rounded-full bg-surface-sunken text-ink-secondary">
          <Icon name={icon} size={20} />
        </span>
      )}
      <div className={size === 'inline' ? 'min-w-0 flex-1' : 'flex max-w-prose flex-col gap-1'}>
        <Title className={`font-semibold text-ink ${size === 'page' ? 'text-lg' : ''}`}>
          {title}
        </Title>
        {body === undefined ? null : <div className="text-ink-secondary">{body}</div>}
      </div>
      {action === undefined ? null : <div className="mt-2">{action}</div>}
    </div>
  );
}
