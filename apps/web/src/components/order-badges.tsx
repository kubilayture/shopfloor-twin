import type { CommandState, OrderDto } from '@shopfloor/contracts/mes-api';
import {
  COMMAND_STATE_TEXT,
  ORDER_STATUS_TEXT,
  ORDER_STATUS_TONE,
  TONE_CLASS,
  flagTexts,
} from '../domain/orders.ts';

const badge = 'rounded border px-1.5 text-xs font-medium whitespace-nowrap';

export function OrderStatusBadge({ order }: { readonly order: Pick<OrderDto, 'status'> }) {
  return (
    <span
      data-testid="order-status"
      data-status={order.status}
      className={`${badge} ${TONE_CLASS[ORDER_STATUS_TONE[order.status]]}`}
    >
      {ORDER_STATUS_TEXT[order.status]}
    </span>
  );
}

export function OrderFlags({ order }: { readonly order: Pick<OrderDto, 'flags'> }) {
  const flags = flagTexts(order);
  if (flags.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1" data-testid="order-flags">
      {flags.map((flag) => (
        <span key={flag} className={`${badge} ${TONE_CLASS.warn}`}>
          {flag}
        </span>
      ))}
    </span>
  );
}

export function CommandStateBadge({ state }: { readonly state: CommandState }) {
  const text = COMMAND_STATE_TEXT[state];
  return (
    <span
      data-testid="command-state"
      data-state={state}
      title={text.meaning}
      className={`${badge} ${TONE_CLASS[text.tone]}`}
    >
      {text.label}
    </span>
  );
}
