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
import { useEffect, useRef, useState } from 'react';
import { writeOrder, type OrderActionBody } from '../api/orders.ts';
import { useAuth, useUnsavedDraft } from '../auth/auth.tsx';
import { Button, type ButtonVariant } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Code } from '../components/ui/code.tsx';
import { NumberInput, Select, Textarea } from '../components/ui/controls.tsx';
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

/**
 * The look of a form's send button (design system 4.1 and 4.9): the inline form is the write's
 * confirmation, so a destructive write (cancel the order, abandon a command) sends with the solid
 * danger button a destructive confirmation uses; every other write, closing a completed order
 * included (the flow's normal end), with the form's primary button.
 */
const SUBMIT_VARIANT: Readonly<Record<ActionDraft['action'], ButtonVariant>> = {
  release: 'primary',
  dispatch: 'primary',
  redispatch: 'primary',
  close: 'primary',
  cancel: 'dangerSolid',
  abandon: 'dangerSolid',
};

const PERMISSION: Readonly<Record<ActionDraft['action'], Permission>> = {
  release: 'order:release',
  dispatch: 'order:dispatch',
  cancel: 'order:cancel',
  redispatch: 'order:redispatch',
  close: 'order:close',
  abandon: 'order:abandon',
};

/**
 * What each write does, said before it is sent; an irreversible one (cancel, close, abandon) says
 * it cannot be undone (design system 4.9).
 */
function effectText(draft: ActionDraft, order: OrderDto): string {
  switch (draft.action) {
    case 'release':
      return 'Releases the order for dispatch and tells the ERP it is released.';
    case 'dispatch':
      return `Sends the whole order (${String(order.quantity)} blanks) as one job to a CNC. The command goes out through the MES's outbox; its state shows below.`;
    case 'redispatch':
      return `Sends the remainder again as a new command: at most ${String(order.remaining)} blanks (the order quantity minus the blanks the device accepted).`;
    case 'cancel':
      return 'Cancels the order (not dispatched yet) and tells the ERP it is cancelled. This cannot be undone.';
    case 'close':
      return 'Closes the completed order and tells the ERP it is closed. This cannot be undone.';
    case 'abandon':
      return `Writes off ${draft.commandId}: its device run has ended. It becomes abandoned (settled, its incidents closed) and its whole quantity counts as dispatched, so the order can end short, never over. This cannot be undone.`;
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

/**
 * A refused write (design system 4.7): an `alarm` callout at the top of the form, announced
 * (`role="alert"`), with the problem type and, for a close refused for quality holds, a link to
 * each hold. `data-kind` and `data-type` say which refusal it is (the specs read both).
 */
function FailureText({ failure }: { readonly failure: OrderFailure }) {
  return (
    <Callout
      tone="alarm"
      role="alert"
      data-testid="action-message"
      data-kind={failure.kind}
      data-type={failure.type ?? ''}
    >
      <p>{failure.text}</p>
      {failure.holds && failure.holds.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1" data-testid="action-holds" aria-label="Open holds">
          {failure.holds.map((id) => (
            <li key={id}>
              <Link
                to="/quality/holds/$id"
                params={{ id }}
                data-testid={`action-hold-${id}`}
                className="font-medium text-link underline underline-offset-4"
              >
                Hold <span className="whitespace-nowrap">{id}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {failure.type ? (
        <p className="mt-2 text-xs" data-testid="action-problem-type">
          Problem type: <Code>{failure.type}</Code>
        </p>
      ) : null}
    </Callout>
  );
}

/** The CNC to dispatch to: none chosen leaves it to the dispatch rule. */
function CncSelect({
  value,
  targets,
  onChange,
}: {
  readonly value: string;
  readonly targets: readonly EquipmentDto[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <Select
      label="CNC"
      name="equipment"
      data-testid="action-cnc"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      className="w-full sm:w-auto sm:max-w-md"
    >
      <option value="">The dispatch rule chooses (queue finishing first)</option>
      {targets.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name} ({item.id})
        </option>
      ))}
    </Select>
  );
}

/**
 * One write being prepared (#176). The draft keeps the order version it started from: when the
 * order moves on (a push, or a read after a 409) it is stale and is never sent with the newer
 * version; the user sees what changed and starts again.
 *
 * The form is the write's confirmation (design system 4.9: the order actions keep their inline
 * confirm and its ids): it says what the write does before it is sent, and its send button repeats
 * the verb. It takes the focus when it opens; while the write is on its way the send button is
 * busy (it keeps the focus, a second submit is ignored); Escape and Back close it.
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
  const fieldError = invalid.length > 0 ? invalid.join(' ') : undefined;
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
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 text-ink sm:p-5"
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
      <div className="flex flex-col gap-1">
        <Heading className="text-lg font-semibold">
          {text.label}
          {draft.action === 'abandon' ? (
            <>
              : <Code>{draft.commandId}</Code>
            </>
          ) : null}
        </Heading>
        <p className="text-sm">{effectText(draft, order)}</p>
        <p className="text-xs text-ink-secondary">
          Prepared on version {draft.version} of the order; the MES refuses it if the order has
          changed since.
        </p>
      </div>
      {failure ? <FailureText failure={failure} /> : null}
      {invalid.length > 0 ? (
        <Callout tone="alarm" role="alert" data-testid="action-invalid">
          {invalid.join(' ')}
        </Callout>
      ) : null}
      {stale ? (
        <Callout
          tone="warn"
          role="alert"
          data-testid="action-stale"
          data-version={String(order.version)}
          title="The order changed while you prepared this"
        >
          <p>
            It is at version {order.version} ({ORDER_STATUS_TEXT[order.status]}), you started on
            version {draft.version}. Nothing is sent with the newer version.{' '}
            {applies
              ? 'Check the order above, then start again: what you entered is kept.'
              : 'This action no longer applies to the order.'}
          </p>
          {applies ? (
            <Button
              data-testid="action-restart"
              size="sm"
              className="mt-2"
              onClick={() => {
                setDraft((current) => ({ ...current, version: order.version }));
                setFailure(undefined);
                submit.current?.focus();
              }}
            >
              Start again on version {order.version}
            </Button>
          ) : null}
        </Callout>
      ) : null}
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
        <NumberInput
          label="Quantity"
          name="quantity"
          unit="blanks"
          hint={`Leave it empty to send all ${String(order.remaining)} remaining.`}
          error={fieldError}
          data-testid="action-quantity"
          inputMode="numeric"
          value={draft.quantity}
          onChange={(event) => {
            const quantity = event.target.value;
            setDraft((current) => ({ ...current, quantity }));
          }}
        />
      ) : null}
      {draft.action === 'redispatch' && unsettled.length > 0 ? (
        <Callout tone="warn" role="status" data-testid="action-unsettled">
          Not settled yet:{' '}
          {unsettled
            .map((command) => `${command.commandId} (${COMMAND_STATE_TEXT[command.state].label})`)
            .join(', ')}
          . The MES re-dispatches only once every earlier command is settled, so it may refuse
          (commands-unsettled).
        </Callout>
      ) : null}
      {draft.action === 'cancel' ? (
        <Textarea
          label="Reason"
          name="reason"
          data-testid="action-reason"
          value={draft.reason}
          rows={2}
          max={ORDER_LIMITS.reason}
          error={fieldError}
          onChange={(event) => {
            const reason = event.target.value;
            setDraft((current) => ({ ...current, reason }));
          }}
          fieldClassName="max-w-xl"
        />
      ) : null}
      {/* Back first, the send button last, on the right of the pair (design system 4.1). */}
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="action-back"
          onClick={() => {
            onClose();
          }}
        >
          Back
        </Button>
        <Button
          ref={submit}
          type="submit"
          variant={SUBMIT_VARIANT[draft.action]}
          data-testid="action-submit"
          disabled={stale || !applies}
          loading={write.isPending}
        >
          {text.label}
        </Button>
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
