import {
  ORDER_LIMITS,
  ORDER_STATUSES,
  PROBLEM_TYPES,
  type CommandDetailDto,
  type CommandDto,
  type CommandResultDto,
  type CommandState,
  type EquipmentDto,
  type OrderDetail,
  type OrderDto,
  type OrderStatus,
} from '@shopfloor/contracts/mes-api';
import { ApiError } from '../api/client.ts';
import { writeFailure, type WriteFailure } from './writes.ts';

// What the orders screens (#176) show and decide, as pure functions: labels, the newest of a
// read and a pushed copy, which supervisor actions an order offers, and the drafts of those
// actions with the version they started from.

export const ORDER_STATUS_TEXT: Readonly<Record<OrderStatus, string>> = {
  imported: 'Imported',
  rejected: 'Rejected at import',
  released: 'Released',
  dispatched: 'Dispatched',
  'in-progress': 'In progress',
  completed: 'Completed',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

/** The list's filters: `open` (still to be worked on or closed) or one status. */
export const ORDER_FILTERS = ['open', ...ORDER_STATUSES] as const;
export type OrderFilter = (typeof ORDER_FILTERS)[number];

/** The statuses of a filter; none (all) without one. */
export function filterStatuses(filter: OrderFilter | undefined): OrderStatus[] {
  if (filter === undefined) return [];
  if (filter === 'open') return ['imported', 'released', 'dispatched', 'in-progress', 'completed'];
  return [filter];
}

export type Tone = 'neutral' | 'info' | 'good' | 'warn' | 'bad';

export const ORDER_STATUS_TONE: Readonly<Record<OrderStatus, Tone>> = {
  imported: 'neutral',
  rejected: 'bad',
  released: 'info',
  dispatched: 'info',
  'in-progress': 'info',
  completed: 'good',
  closed: 'good',
  cancelled: 'neutral',
};

/** A command's state for people: a label and what it means for the order (ADR-0029). */
export const COMMAND_STATE_TEXT: Readonly<
  Record<CommandState, { readonly label: string; readonly meaning: string; readonly tone: Tone }>
> = {
  queued: {
    label: 'Queued',
    meaning:
      "Not published yet: its CNC's previous command is not settled, or the gateway is offline.",
    tone: 'neutral',
  },
  sent: { label: 'Sent', meaning: 'Published; no final answer yet.', tone: 'info' },
  unknown: {
    label: 'Unknown',
    meaning: 'The gateway could not learn the outcome yet and is settling it. Not final.',
    tone: 'warn',
  },
  failed: {
    label: 'Failed',
    meaning:
      'No final answer by the expiry of its first unanswered delivery plus the margin: an incident. Not final; a re-dispatch waits until it is settled.',
    tone: 'bad',
  },
  accepted: { label: 'Accepted', meaning: 'The job exists on the device.', tone: 'good' },
  rejected: { label: 'Rejected', meaning: 'The device refused the job: no job.', tone: 'bad' },
  expired: {
    label: 'Expired',
    meaning: 'Every delivery expired before the device accepted it: no job.',
    tone: 'warn',
  },
  'not-accepted': {
    label: 'Not accepted',
    meaning:
      "Settled from the CNC's facts: they arrived past the expiry without its acceptance, so no job.",
    tone: 'warn',
  },
  'epoch-ended': {
    label: 'Run ended',
    meaning: 'The device run it was meant for ended first: no job from it.',
    tone: 'warn',
  },
  conflict: {
    label: 'Conflict',
    meaning:
      'The device holds another job under this command id: an incident, not settled until its run ends.',
    tone: 'bad',
  },
  abandoned: {
    label: 'Abandoned',
    meaning: 'Written off by a supervisor after its run ended; its quantity counts as started.',
    tone: 'neutral',
  },
};

export const RESULT_TEXT: Readonly<Record<CommandResultDto['result'], string>> = {
  accepted: 'Accepted',
  duplicate: 'Duplicate (accepted before)',
  rejected: 'Rejected',
  expired: 'Expired',
  unknown: 'Unknown (settling)',
};

export const TONE_CLASS: Readonly<Record<Tone, string>> = {
  neutral: 'border-slate-500 text-slate-800',
  info: 'border-sky-800 text-sky-900',
  good: 'border-emerald-800 text-emerald-900',
  warn: 'border-amber-700 text-amber-950',
  bad: 'border-red-800 text-red-900',
};

/** The order flags for people, in a fixed order. */
export function flagTexts(order: Pick<OrderDto, 'flags'>): string[] {
  const texts: string[] = [];
  if (order.flags.short) texts.push('Short');
  if (order.flags.dispatchFailed) texts.push('Dispatch failed');
  if (order.flags.dispatchLost) texts.push('Dispatch lost');
  return texts;
}

/** Whether `incoming` is at least as new as `known` (same order): every change raises `version`. */
export function isNewerOrder(incoming: OrderDto, known: OrderDto): boolean {
  if (incoming.version !== known.version) return incoming.version > known.version;
  return Date.parse(incoming.updatedAt) >= Date.parse(known.updatedAt);
}

/**
 * The newer of a read and a pushed copy of one order. A pushed copy wins only when strictly newer
 * (a higher version, or the same version changed later): at an equal version and `updatedAt` the
 * read wins, as it may carry what a push of the same version did not (#176 review H1).
 */
export function newestOrder(read: OrderDto, pushed: OrderDto | undefined): OrderDto {
  if (!pushed) return read;
  if (pushed.version !== read.version) return pushed.version > read.version ? pushed : read;
  return Date.parse(pushed.updatedAt) > Date.parse(read.updatedAt) ? pushed : read;
}

/** A command has no version: the later `updatedAt` wins (the MES moves it with every change). */
export function isNewerCommand(incoming: CommandDto, known: CommandDto): boolean {
  return Date.parse(incoming.updatedAt) >= Date.parse(known.updatedAt);
}

const byPlannedStart = (a: OrderDto, b: OrderDto): number =>
  Date.parse(a.plannedStart) - Date.parse(b.plannedStart) || a.id.localeCompare(b.id);

/**
 * The list on screen: the read orders with newer pushed copies, and pushed orders the read does
 * not have (imported since) when their status is one shown; by planned start, then id. When the
 * read was truncated, a pushed-only order that sorts after the last one read is left out: the
 * MES may hold others before it that the read cut off, so it would show out of place.
 */
export function mergeOrders(
  read: readonly OrderDto[],
  pushed: Readonly<Record<string, OrderDto>> | undefined,
  statuses: readonly OrderStatus[],
  truncated = false,
): OrderDto[] {
  const shown = (order: OrderDto) => statuses.length === 0 || statuses.includes(order.status);
  const last = [...read].sort(byPlannedStart).at(-1);
  const byId = new Map<string, OrderDto>();
  for (const order of read) byId.set(order.id, newestOrder(order, pushed?.[order.id]));
  for (const order of Object.values(pushed ?? {})) {
    if (byId.has(order.id)) continue;
    if (truncated && last && byPlannedStart(order, last) > 0) continue;
    byId.set(order.id, order);
  }
  return [...byId.values()].filter(shown).sort(byPlannedStart);
}

/**
 * An order's commands on screen: the read ones (with every delivery and result) with the fields
 * of a newer pushed copy, and pushed commands of the order the read does not have yet; by `n`.
 */
export function mergeCommands(
  orderId: string,
  read: readonly CommandDetailDto[],
  pushed: Readonly<Record<string, CommandDto>> | undefined,
): CommandDetailDto[] {
  const byId = new Map<string, CommandDetailDto>();
  for (const command of read) {
    const live = pushed?.[command.commandId];
    byId.set(
      command.commandId,
      // Strictly later only: at the same `updatedAt` the read (with its results) wins.
      live?.orderId === orderId && Date.parse(live.updatedAt) > Date.parse(command.updatedAt)
        ? { ...command, ...live }
        : command,
    );
  }
  for (const command of Object.values(pushed ?? {})) {
    if (command.orderId !== orderId || byId.has(command.commandId)) continue;
    byId.set(command.commandId, { ...command, attemptList: [], results: [] });
  }
  return [...byId.values()].sort((a, b) => a.n - b.n);
}

/** The order-level writes, in the order the screen offers them. */
export const ORDER_ACTIONS = ['release', 'dispatch', 'redispatch', 'cancel', 'close'] as const;
export type OrderLevelAction = (typeof ORDER_ACTIONS)[number];

export const ACTION_TEXT: Readonly<
  Record<OrderLevelAction | 'abandon', { readonly label: string; readonly done: string }>
> = {
  release: { label: 'Release', done: 'Released' },
  dispatch: { label: 'Dispatch', done: 'Dispatched' },
  redispatch: { label: 'Re-dispatch the remainder', done: 'Re-dispatched' },
  cancel: { label: 'Cancel order', done: 'Cancelled' },
  close: { label: 'Close order', done: 'Closed' },
  abandon: { label: 'Abandon command', done: 'Command abandoned' },
};

/** The statuses each write applies to (the MES's `expectStatus`, #174). */
const ACTION_STATUSES: Readonly<Record<OrderLevelAction | 'abandon', readonly OrderStatus[]>> = {
  release: ['imported'],
  dispatch: ['released'],
  cancel: ['imported', 'released'],
  redispatch: ['dispatched', 'in-progress'],
  close: ['completed'],
  abandon: ['dispatched', 'in-progress'],
};

/** The order-level writes the order's status allows (re-dispatch only with blanks remaining). */
export function availableActions(order: OrderDto): OrderLevelAction[] {
  return ORDER_ACTIONS.filter(
    (action) =>
      ACTION_STATUSES[action].includes(order.status) &&
      (action !== 'redispatch' || order.remaining > 0),
  );
}

/** The commands a re-dispatch waits for: not settled yet (409 `commands-unsettled` otherwise). */
export function unsettledCommands(commands: readonly CommandDto[]): CommandDto[] {
  return commands.filter((command) => !command.settled);
}

/**
 * Whether the MES would let a supervisor abandon the command: the order dispatched or in progress,
 * the command not abandoned, and its device run ended (a newer device epoch exists). The screen
 * knows the run ended from the command itself: `epoch-ended`, or a job `lost` with its run. A
 * command settled otherwise (rejected, expired, …) is not offered: writing it off would count its
 * blanks as started for nothing.
 */
export function canAbandon(order: OrderDto, command: CommandDto): boolean {
  return (
    ACTION_STATUSES.abandon.includes(order.status) &&
    command.state !== 'abandoned' &&
    (command.state === 'epoch-ended' || command.job === 'lost')
  );
}

/** The CNCs an order's dispatch may name: the machines of its OP10 work center. */
export function dispatchTargets(
  equipment: readonly EquipmentDto[],
  routing: OrderDetail['routing'],
): EquipmentDto[] {
  // A work center holds more than its OP10 machines (cell-m1 also has the washer): the machines of
  // the routing's first operation, in its work center when the routing names one.
  const first = routing.find((step) => step.operation === 'OP10') ?? routing[0];
  const operation = first?.operation ?? 'OP10';
  return equipment
    .filter(
      (item) =>
        item.operation === operation &&
        (first === undefined || item.workCenter.id === first.workCenter),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * What a supervisor prepares for one write. It keeps the order version it started from: once the
 * order moves on it is stale and never sent with the newer version (which would apply it to an
 * order the user has not seen).
 */
export interface ActionDraft {
  readonly action: OrderLevelAction | 'abandon';
  readonly version: number;
  /** Dispatch and re-dispatch: a CNC, or '' for the dispatch rule's choice. */
  readonly equipment: string;
  /** Cancel: an optional reason. */
  readonly reason: string;
  /** Re-dispatch: the blanks as typed ('' for the remainder). */
  readonly quantity: string;
  /** Abandon: the command. */
  readonly commandId: string;
}

export function draftFor(
  action: ActionDraft['action'],
  order: OrderDto,
  commandId = '',
): ActionDraft {
  return { action, version: order.version, equipment: '', reason: '', quantity: '', commandId };
}

export const isStaleDraft = (draft: ActionDraft, order: OrderDto): boolean =>
  draft.version !== order.version;

/** Whether the user typed or chose anything (an unsaved draft, #170). */
export const isDirtyDraft = (draft: ActionDraft): boolean =>
  draft.equipment !== '' || draft.reason.trim() !== '' || draft.quantity.trim() !== '';

/** What the form checks before sending (the shared schemas check again). */
export function draftProblems(draft: ActionDraft, order: OrderDto): string[] {
  const found: string[] = [];
  if (draft.action === 'redispatch' && draft.quantity.trim() !== '') {
    // Digits only: `Number` would take `1e2`, `0x10` or ` 5 ` as numbers.
    const digits = draft.quantity.trim();
    const quantity = /^\d{1,9}$/.test(digits) ? Number(digits) : Number.NaN;
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      found.push('The quantity is a whole number of blanks, at least 1.');
    } else if (quantity > order.remaining) {
      found.push(`At most the ${String(order.remaining)} blanks remaining.`);
    }
  }
  if (draft.action === 'cancel' && draft.reason.length > ORDER_LIMITS.reason) {
    found.push(`The reason is at most ${String(ORDER_LIMITS.reason)} characters.`);
  }
  return found;
}

/** A failed order write: the kinds of `writeFailure` and the orders module's 409s. */
export interface OrderFailure {
  readonly kind:
    | WriteFailure['kind']
    | 'stale'
    | 'state'
    | 'unsettled'
    | 'sign-off'
    | 'quality-hold'
    | 'genealogy-pending';
  readonly text: string;
  /** The problem type the MES answered, shown as is (`urn:shopfloor:…`). */
  readonly type: string | undefined;
  /** The open holds a close was refused for (`quality-hold`, #203), each linked. */
  readonly holds?: readonly string[];
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function orderFailure(error: unknown): OrderFailure {
  const type =
    error instanceof ApiError && error.problem?.type !== 'about:blank'
      ? error.problem?.type
      : undefined;
  if (error instanceof ApiError) {
    const detail = error.problem?.detail ?? error.message;
    if (type === PROBLEM_TYPES.orderStale) {
      return {
        kind: 'stale',
        type,
        text: 'Not done: the order changed since you started (409). Nothing was sent with the newer version; the order is read again so you can check it and start again.',
      };
    }
    if (type === PROBLEM_TYPES.orderState) {
      return {
        kind: 'state',
        type,
        text: `Not done: the order's status does not allow this now (409, ${detail}).`,
      };
    }
    if (type === PROBLEM_TYPES.signOffMissing) {
      // #177: a close needs every operation signed off at its work center's terminal.
      return {
        kind: 'sign-off',
        type,
        text: `Not closed: not every operation is signed off at its terminal yet (409, ${detail}). Operators sign off each completed operation at their work center's terminal; then close again.`,
      };
    }
    if (type === PROBLEM_TYPES.qualityHold) {
      // #201, #203: the detail names the open holds that cover a unit of the order (or the order).
      const holds = [...new Set([...detail.matchAll(UUID)].map((m) => m[0].toLowerCase()))];
      return {
        kind: 'quality-hold',
        type,
        holds,
        text: `Not closed: ${holds.length === 1 ? 'an open quality hold covers' : 'open quality holds cover'} units of this order or the order itself (409). Quality releases or rejects ${holds.length === 1 ? 'it' : 'them'} first; a hold never changes quantities. Then close again.`,
      };
    }
    if (type === PROBLEM_TYPES.genealogyPending) {
      // #201: retryable; genealogy catches up within about a second.
      return {
        kind: 'genealogy-pending',
        type,
        text: `Not closed yet: the genealogy has not processed every fact of the order's units, so the MES cannot tell whether a held lot went into it (409, retryable). Try again in ${String(error.retryAfter ?? 2)} s. (${detail})`,
      };
    }
    if (type === PROBLEM_TYPES.commandsUnsettled) {
      return {
        kind: 'unsettled',
        type,
        text: `Not done: an earlier command of the order is not settled yet, so a re-dispatch could make a second job (409, ${detail}).`,
      };
    }
  }
  const failure = writeFailure(error, {
    not: 'Not done',
    conflict: 'the MES refused it as a conflict.',
    what: 'this write',
  });
  return { ...failure, type };
}

/** `cnc-01: 3, cnc-02: 1` for a record of counts; '–' when empty. */
export function countsText(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).filter(([, value]) => value !== 0);
  if (entries.length === 0) return '–';
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ');
}
