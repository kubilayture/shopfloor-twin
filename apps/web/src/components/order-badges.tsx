import type { CommandState, OrderDto } from '@shopfloor/contracts/mes-api';
import {
  COMMAND_STATE_TEXT,
  ORDER_STATUS_TEXT,
  ORDER_STATUS_TONE,
  flagTexts,
} from '../domain/orders.ts';
import { Badge } from './ui/badge.tsx';

/** An order's status (design system 2.6): `data-status` raw, the word for people. */
export function OrderStatusBadge({ order }: { readonly order: Pick<OrderDto, 'status'> }) {
  return (
    <Badge
      data-testid="order-status"
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
