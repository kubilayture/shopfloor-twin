import type { ReactNode } from 'react';
import { Icon } from './icons.tsx';

/**
 * A disclosure (UX-1e, #317; design system 4.12): a styled `<details>`/`<summary>` for what most
 * readers skip ("What the status means", "Bill of materials", "Payload", "Technical details"),
 * with a chevron that turns when open and a hit area of at least 24 px. Native: keyboard,
 * screen readers and find-in-page work without script.
 */
export interface DisclosureProps {
  readonly summary: ReactNode;
  readonly defaultOpen?: boolean;
  readonly testId?: string | undefined;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Disclosure({
  summary,
  defaultOpen = false,
  testId,
  className,
  children,
}: DisclosureProps) {
  return (
    <details
      data-testid={testId}
      open={defaultOpen}
      className={`group text-sm${className ? ` ${className}` : ''}`}
    >
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1.5 rounded-sm font-medium text-ink hover:text-accent [&::-webkit-details-marker]:hidden">
        <Icon
          name="chevron-right"
          size={16}
          className="text-ink-secondary group-open:rotate-90 motion-safe:transition-transform motion-safe:duration-fast"
        />
        {summary}
      </summary>
      <div className="mt-2 pl-5.5">{children}</div>
    </details>
  );
}
