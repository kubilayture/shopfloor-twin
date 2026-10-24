import { PRIORITY_LABELS, type Priority } from '../domain/alarms.ts';
import { BadgeFrame } from './ui/badge.tsx';
import type { IconName } from './ui/icons.tsx';

/**
 * An alarm priority (design system 2.5): the word, its glyph and the priority's token colours
 * (AA contrast); `data-priority` carries the raw value. Never colour alone.
 */
export const PRIORITY_COLORS: Readonly<Record<Priority, string>> = {
  high: 'bg-priority-high-fill text-priority-high-ink border-priority-high-border',
  medium: 'bg-priority-medium-fill text-priority-medium-ink border-priority-medium-border',
  low: 'bg-priority-low-fill text-priority-low-ink border-priority-low-border',
};

const GLYPH: Readonly<Record<Priority, IconName>> = {
  high: 'triangles-up',
  medium: 'triangle-up',
  low: 'dot',
};

export function PriorityBadge({
  priority,
  testId,
}: {
  readonly priority: Priority;
  readonly testId?: string;
}) {
  return (
    <BadgeFrame
      data-testid={testId}
      data-priority={priority}
      colors={PRIORITY_COLORS[priority]}
      icon={GLYPH[priority]}
    >
      {PRIORITY_LABELS[priority]}
    </BadgeFrame>
  );
}
