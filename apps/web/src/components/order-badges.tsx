import type { CommandState, OrderDto } from '@shopfloor/contracts/mes-api';
import {
  COMMAND_STATE_TEXT,
  ORDER_STATUS_TEXT,
  ORDER_STATUS_TONE,
  flagTexts,
  priorityGlyph,
} from '../domain/orders.ts';
import { Badge } from './ui/badge.tsx';

/**
 * An order's status (design system 2.6): `data-status` raw, the word for people. `testId` null
 * where a page lists several orders (the trace search, #364): no `order-status` id then.
 */
export function OrderStatusBadge({
  order,
  testId = 'order-status',
}: {
  readonly order: Pick<OrderDto, 'status'>;
  readonly testId?: string | null;
}) {
  return (
    <Badge
      data-testid={testId ?? undefined}
      data-status={order.status}
      tone={ORDER_STATUS_TONE[order.status]}
      icon={order.status === 'completed' ? 'check' : undefined}
    >
      {ORDER_STATUS_TEXT[order.status]}
    </Badge>
  );
}

/** Short, Dispatch failed, Dispatch lost: each a `warn` badge (design system 2.6). */
export function OrderFlags({ order }: { readonly order: Pick<OrderDto, 'flags'> }) {
  const flags = flagTexts(order);
  if (flags.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1" data-testid="order-flags">
      {flags.map((flag) => (
        <Badge key={flag} tone="warn" icon="alert">
          {flag}
        </Badge>
      ))}
    </span>
  );
}

export function CommandStateBadge({ state }: { readonly state: CommandState }) {
  const text = COMMAND_STATE_TEXT[state];
  return (
    <Badge data-testid="command-state" data-state={state} title={text.meaning} tone={text.tone}>
      {text.label}
    </Badge>
  );
}

/**
 * The ERP's priority (P-02): the number in a neutral outline badge, with a glyph for the two most
 * urgent (1 and 2), so it reads as a priority beside the alarm screens' badges. Urgency is not an
 * abnormal state, so no colour (design system 1.2). `data-priority` is the raw number.
 */
export function OrderPriorityBadge({ priority }: { readonly priority: number }) {
  return (
    <Badge
      tone="neutral"
      variant="outline"
      icon={priorityGlyph(priority)}
      title={`Priority ${String(priority)}; 1 is the most urgent`}
      data-priority={String(priority)}
    >
      {priority}
    </Badge>
  );
}

/** An unfinished order past its due date (P-02): a `warn` badge with the clock glyph. */
export function OverdueBadge() {
  return (
    <Badge tone="warn" icon="clock" data-testid="order-overdue">
      Overdue
    </Badge>
  );
}
