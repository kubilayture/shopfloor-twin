import {
  PROBLEM_TYPES,
  type ActivityDto,
  type CrewMemberDto,
  type PauseReason,
  type TerminalOperationDto,
  type TerminalViewDto,
  type scrapReasonListSchema,
} from '@shopfloor/contracts/mes-api';
import type { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { writeFailure, type WriteFailure } from './writes.ts';

/** One reason of the scrap tree (`GET /scrap-reasons`). */
export type ScrapReasonDto = z.infer<typeof scrapReasonListSchema>['reasons'][number];

// The operator terminal on screen (#177): what an operator may do on an order operation, the
// texts of the pause reasons and the refusals, and how a write's answer updates the view shown.

export const PAUSE_REASON_LABELS: Readonly<Record<PauseReason, string>> = {
  break: 'Break',
  material: 'Waiting for material',
  quality: 'Quality check',
  maintenance: 'Maintenance',
  instruction: 'Instruction or meeting',
  other: 'Other',
};

export const CREW_END_LABELS: Readonly<Record<NonNullable<CrewMemberDto['endReason']>, string>> = {
  'sign-off': 'signed off',
  'session-ended': 'session ended',
  'shift-ended': 'shift ended',
  replaced: 'signed on elsewhere',
};

/** The operator's own open interval on the operation, if any. */
export function myActivity(
  operation: TerminalOperationDto,
  userId: number,
): ActivityDto | undefined {
  return operation.activities.find((a) => a.userId === userId);
}

export interface OperationActions {
  readonly start: boolean;
  readonly pause: boolean;
  readonly resume: boolean;
  readonly signOff: boolean;
}

/**
 * What the operator may do on the operation now, as the MES decides it (the buttons shown): start
 * with nothing of theirs open, pause while working, resume while paused, sign off once complete.
 * Nothing once signed off or while the order is not dispatched, in progress or completed.
 */
export function operationActions(
  operation: TerminalOperationDto,
  orderStatus: string,
  userId: number,
): OperationActions {
  const open = ['dispatched', 'in-progress', 'completed'].includes(orderStatus);
  if (!open || operation.signedOff) {
    return { start: false, pause: false, resume: false, signOff: false };
  }
  const mine = myActivity(operation, userId);
  return {
    start: mine === undefined,
    pause: mine?.kind === 'work',
    resume: mine?.kind === 'pause',
    signOff: operation.complete,
  };
}

/** The view with one operation replaced by a write's answer (until the next push says more). */
export function withOperation(
  view: TerminalViewDto,
  operation: TerminalOperationDto,
): TerminalViewDto {
  return {
    ...view,
    orders: view.orders.map((order) =>
      order.order.id !== operation.orderId
        ? order
        : {
            ...order,
            operations: order.operations.map((op) =>
              op.operation === operation.operation ? { ...op, ...operation } : op,
            ),
          },
    ),
  };
}

/** The view without a scrap record (coded: it is no longer waiting). */
export function withoutScrapRecord(view: TerminalViewDto, id: number): TerminalViewDto {
  return { ...view, scrapRecords: view.scrapRecords.filter((r) => r.id !== id) };
}

/** Whether the user holds a crew row at the view's work center. */
export const signedOnHere = (view: TerminalViewDto, userId: number): boolean =>
  view.crew.some((c) => c.userId === userId);

/** The reasons a scrap record may be coded with: its machine reason or one below it, active. */
export function codableReasons(
  reasons: readonly ScrapReasonDto[],
  machineReason: string,
): ScrapReasonDto[] {
  return reasons.filter(
    (r) => r.active && (r.id === machineReason || r.id.startsWith(`${machineReason}/`)),
  );
}

const TEXTS: Readonly<Record<string, string>> = {
  [PROBLEM_TYPES.operationStale]:
    'someone changed this operation meanwhile; the screen shows it now. Try again.',
  [PROBLEM_TYPES.operationState]: '',
  [PROBLEM_TYPES.notSignedOn]: 'you are not signed on here any more. Sign on again.',
  [PROBLEM_TYPES.terminalSessionRequired]: 'log in at this terminal first.',
  [PROBLEM_TYPES.noShift]: 'no shift is running now, so nobody can sign on.',
  [PROBLEM_TYPES.scrapStale]: 'someone coded this record meanwhile; the screen shows it now.',
};

/** A refused terminal write as a message: the MES's reason for a state conflict. */
export function terminalFailure(error: unknown, not: string): WriteFailure {
  if (error instanceof ApiError && error.status === 409) {
    const type = error.problem?.type ?? '';
    const text = TEXTS[type];
    const detail = error.problem?.detail ?? error.message;
    return {
      kind: 'conflict',
      text: `${not}: ${text === undefined || text === '' ? detail : text}`,
    };
  }
  return writeFailure(error, { not, conflict: 'try again.', what: 'this' });
}
