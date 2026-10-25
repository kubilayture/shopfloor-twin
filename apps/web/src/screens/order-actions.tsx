import {
  ORDER_LIMITS,
  type CommandDto,
  type EquipmentDto,
  type OrderDto,
  type OrderWriteResult,
} from '@shopfloor/contracts/mes-api';
import type { Permission } from '@shopfloor/contracts/identity';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { writeOrder, type OrderActionBody } from '../api/orders.ts';
import { useAuth, useUnsavedDraft } from '../auth/auth.tsx';
import {
  ACTION_TEXT,
  COMMAND_STATE_TEXT,
  ORDER_STATUS_TEXT,
  availableActions,
  canAbandon,
  draftProblems,
  isDirtyDraft,
  isStaleDraft,
  orderFailure,
  unsettledCommands,
  type ActionDraft,
  type OrderFailure,
  type OrderLevelAction,
} from '../domain/orders.ts';
import { upsertCommand, upsertOrder } from '../live/live-cache.ts';

const inputClass = 'rounded border border-slate-500 bg-white px-2 py-1 text-sm';
export const buttonClass =
  'rounded border border-slate-500 bg-white px-3 py-1 text-sm font-medium hover:bg-slate-100 disabled:opacity-50';
const primaryClass =
  'rounded bg-sky-800 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-900 disabled:opacity-50';

const PERMISSION: Readonly<Record<ActionDraft['action'], Permission>> = {
  release: 'order:release',
  dispatch: 'order:dispatch',
  cancel: 'order:cancel',
  redispatch: 'order:redispatch',
  close: 'order:close',
  abandon: 'order:abandon',
};

/** What each write does, said before it is sent. */
function effectText(draft: ActionDraft, order: OrderDto): string {
  switch (draft.action) {
    case 'release':
      return 'Releases the order for dispatch and tells the ERP it is released.';
    case 'dispatch':
      return `Sends the whole order (${String(order.quantity)} blanks) as one job to a CNC. The command goes out through the MES's outbox; its state shows below.`;
    case 'redispatch':
      return `Sends the remainder again as a new command: at most ${String(order.remaining)} blanks (the order quantity minus the blanks the device accepted).`;
    case 'cancel':
      return 'Cancels the order (not dispatched yet) and tells the ERP it is cancelled.';
    case 'close':
      return 'Closes the completed order and tells the ERP it is closed.';
    case 'abandon':
      return `Writes off ${draft.commandId}: its device run has ended. It becomes abandoned (settled, its incidents closed) and its whole quantity counts as dispatched, so the order can end short, never over.`;
  }
}

function bodyOf(draft: ActionDraft): OrderActionBody {
  const version = draft.version;
  const equipment = draft.equipment === '' ? {} : { equipment: draft.equipment };
  switch (draft.action) {
    case 'release':
    case 'close':
      return { action: draft.action, body: { version } };
    case 'dispatch':
      return { action: 'dispatch', body: { version, ...equipment } };
    case 'cancel': {
      const reason = draft.reason.trim();
      return { action: 'cancel', body: { version, ...(reason === '' ? {} : { reason }) } };
    }
    case 'redispatch': {
      const quantity = draft.quantity.trim();
      return {
        action: 'redispatch',
        body: { version, ...equipment, ...(quantity === '' ? {} : { quantity: Number(quantity) }) },
      };
    }
    case 'abandon':
      return { action: 'abandon', body: { version, commandId: draft.commandId } };
  }
}

/** Whether the draft's write still applies to the order as it is now. */
function stillApplies(draft: ActionDraft, order: OrderDto, commands: readonly CommandDto[]) {
  if (draft.action === 'abandon') {
    const command = commands.find((item) => item.commandId === draft.commandId);
    return command !== undefined && canAbandon(order, command);
  }
  return availableActions(order).includes(draft.action);
}

export interface Done {
  readonly text: string;
}

function FailureText({ failure }: { readonly failure: OrderFailure }) {
  return (
    <div
      role="alert"
      data-testid="action-message"
      data-kind={failure.kind}
      data-type={failure.type ?? ''}
      className="rounded border border-red-800 bg-red-50 p-2 text-sm text-red-950"
    >
      <p>{failure.text}</p>
      {failure.holds && failure.holds.length > 0 ? (
        <ul className="mt-1 list-disc pl-5" data-testid="action-holds">
          {failure.holds.map((id) => (
            <li key={id}>
              <Link
                to="/quality/holds/$id"
                params={{ id }}
                data-testid={`action-hold-${id}`}
                className="text-sky-800 underline"
              >
                Hold {id}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {failure.type ? (
        <p className="mt-1 font-mono text-xs" data-testid="action-problem-type">
          Problem type: {failure.type}
        </p>
      ) : null}
    </div>
  );
}

function CncSelect({
  value,
  targets,
  onChange,
}: {
  readonly value: string;
  readonly targets: readonly EquipmentDto[];
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        CNC
      </label>
      <select
        id={id}
        data-testid="action-cnc"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={`${inputClass} max-w-xs`}
      >
        <option value="">The dispatch rule chooses (queue finishing first)</option>
        {targets.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} ({item.id})
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * One write being prepared (#176). The draft keeps the order version it started from: when the
 * order moves on (a push, or a read after a 409) it is stale and is never sent with the newer
 * version; the user sees what changed and starts again.
 */
export function ActionForm({
  order,
  commands,
  targets,
  initial,
  onClose,
  onWritten,
  headingLevel = 3,
}: {
  readonly order: OrderDto;
  readonly commands: readonly CommandDto[];
  readonly targets: readonly EquipmentDto[];
  readonly initial: ActionDraft;
  readonly onClose: (done?: Done) => void;
  /** Reads the order again (after a write, or a refusal that says it moved on). */
  readonly onWritten: () => Promise<void>;
  /** The form's heading level where it opens: 2 right under a page header, 3 inside a section. */
  readonly headingLevel?: 2 | 3;
}) {
  const queryClient = useQueryClient();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const [draft, setDraft] = useState<ActionDraft>(initial);
  const [failure, setFailure] = useState<OrderFailure | undefined>(undefined);
  const [invalid, setInvalid] = useState<string[]>([]);
  useUnsavedDraft(isDirtyDraft(draft));
  const reasonId = useId();
  const quantityId = useId();
  const submit = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const sending = useRef(false);
  // The form takes focus when it opens (and the browser brings it into view).
  useEffect(() => {
    form.current?.focus();
  }, []);
  const stale = isStaleDraft(draft, order);
  const applies = stillApplies(draft, order, commands);
  const unsettled = draft.action === 'redispatch' ? unsettledCommands(commands) : [];
  const text = ACTION_TEXT[draft.action];
  const write = useMutation({
    mutationFn: (from: ActionDraft) => writeOrder(order.id, bodyOf(from)),
    onSettled: () => {
      sending.current = false;
    },
    onSuccess: (result: OrderWriteResult) => {
      upsertOrder(queryClient, result.order);
      if (result.command) upsertCommand(queryClient, result.command);
      void onWritten();
      onClose({
        text: `${text.done}${result.command ? ` (command ${result.command.commandId})` : ''}; the order is at version ${String(result.order.version)}.`,
      });
    },
    onError: async (error) => {
      const found = orderFailure(error);
      setFailure(found);
      // The order moved on or its status no longer allows this: read it again, so the newer
      // version shows and the draft is stale (it is never resent with that version).
      if (found.kind === 'stale' || found.kind === 'state' || found.kind === 'unsettled') {
        await onWritten();
      }
    },
  });
  return (
    <form
      ref={form}
      tabIndex={-1}
      noValidate
      aria-label={text.label}
      data-testid={`action-form-${draft.action}`}
      data-version={String(draft.version)}
      className="flex flex-col gap-2 rounded-lg border border-slate-400 bg-white p-3"
      onSubmit={(event) => {
        event.preventDefault();
        // A ref, not `isPending`: two submits before the next render both see it false.
        if (stale || !applies || sending.current) return;
        const found = draftProblems(draft, order);
        setInvalid(found);
        if (found.length > 0) return;
        setFailure(undefined);
        sending.current = true;
        write.mutate(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <Heading className="font-semibold">
        {text.label}
        {draft.action === 'abandon' ? `: ${draft.commandId}` : ''}
      </Heading>
      <p className="text-sm">{effectText(draft, order)}</p>
      <p className="text-xs text-slate-700">
        Prepared on version {draft.version} of the order; the MES refuses it if the order has
        changed since (409).
      </p>
      {draft.action === 'dispatch' || draft.action === 'redispatch' ? (
        <CncSelect
          value={draft.equipment}
          targets={targets}
          onChange={(equipment) => {
            setDraft((current) => ({ ...current, equipment }));
          }}
        />
      ) : null}
      {draft.action === 'redispatch' ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={quantityId} className="text-sm font-medium">
            Blanks (empty: all {order.remaining} remaining)
          </label>
          <input
            id={quantityId}
            data-testid="action-quantity"
            inputMode="numeric"
            value={draft.quantity}
            onChange={(event) => {
              const quantity = event.target.value;
              setDraft((current) => ({ ...current, quantity }));
            }}
            className={`${inputClass} max-w-[10rem]`}
          />
        </div>
      ) : null}
      {draft.action === 'redispatch' && unsettled.length > 0 ? (
        <p role="status" data-testid="action-unsettled" className="text-sm text-amber-950">
          Not settled yet:{' '}
          {unsettled
            .map((command) => `${command.commandId} (${COMMAND_STATE_TEXT[command.state].label})`)
            .join(', ')}
          . The MES re-dispatches only once every earlier command is settled, so it may refuse (409
          commands-unsettled).
        </p>
      ) : null}
      {draft.action === 'cancel' ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={reasonId} className="text-sm font-medium">
            Reason (optional)
          </label>
          <textarea
            id={reasonId}
            data-testid="action-reason"
            value={draft.reason}
            rows={2}
            maxLength={ORDER_LIMITS.reason}
            onChange={(event) => {
              const reason = event.target.value;
              setDraft((current) => ({ ...current, reason }));
            }}
            className={`${inputClass} w-full`}
          />
        </div>
      ) : null}
      {stale ? (
        <div
          role="alert"
          data-testid="action-stale"
          data-version={String(order.version)}
          className="rounded border border-red-800 bg-red-50 p-2 text-sm text-red-950"
        >
          <p>
            The order changed while you prepared this: it is at version {order.version} (
            {ORDER_STATUS_TEXT[order.status]}), you started on version {draft.version}. Nothing is
            sent with the newer version.{' '}
            {applies
              ? 'Check the order above, then start again: what you entered is kept.'
              : 'This action no longer applies to the order.'}
          </p>
          {applies ? (
            <button
              type="button"
              data-testid="action-restart"
              className={`${buttonClass} mt-2`}
              onClick={() => {
                setDraft((current) => ({ ...current, version: order.version }));
                setFailure(undefined);
                submit.current?.focus();
              }}
            >
              Start again on version {order.version}
            </button>
          ) : null}
        </div>
      ) : null}
      {invalid.length > 0 ? (
        <p role="alert" data-testid="action-invalid" className="text-sm text-red-900">
          {invalid.join(' ')}
        </p>
      ) : null}
      {failure ? <FailureText failure={failure} /> : null}
      <div className="flex flex-wrap gap-2">
        <button
          ref={submit}
          type="submit"
          data-testid="action-submit"
          disabled={write.isPending || stale || !applies}
          className={primaryClass}
        >
          {write.isPending ? 'Sending…' : text.label}
        </button>
        <button
          type="button"
          data-testid="action-back"
          className={buttonClass}
          onClick={() => {
            onClose();
          }}
        >
          Back
        </button>
      </div>
    </form>
  );
}

/** The permissions of the session for each write (hidden when missing; the MES refuses too). */
export function useOrderPermissions(): Readonly<Record<ActionDraft['action'], boolean>> {
  const { can } = useAuth();
  return {
    release: can(PERMISSION.release),
    dispatch: can(PERMISSION.dispatch),
    cancel: can(PERMISSION.cancel),
    redispatch: can(PERMISSION.redispatch),
    close: can(PERMISSION.close),
    abandon: can(PERMISSION.abandon),
  };
}

/** The order-level writes this user may start on the order as it is now. */
export function offeredActions(
  order: OrderDto,
  allowed: Readonly<Record<ActionDraft['action'], boolean>>,
): OrderLevelAction[] {
  return availableActions(order).filter((action) => allowed[action]);
}
