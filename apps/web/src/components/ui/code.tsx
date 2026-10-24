import type { ReactNode } from 'react';

/**
 * An identifier in monospace (UX-1c, #315; design system 2.7): equipment ids, lots, serials,
 * cartons, order ids, alarm codes, request ids; at 0.95 em so it sits on the sans baseline.
 * Never for numbers (they are tabular sans).
 */
export function Code({
  children,
  testId,
  className,
}: {
  readonly children: ReactNode;
  readonly testId?: string | undefined;
  readonly className?: string;
}) {
  return (
    <code
      data-testid={testId}
      className={`font-mono text-[0.95em]${className ? ` ${className}` : ''}`}
    >
      {children}
    </code>
  );
}
