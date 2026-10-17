import {
  crewResultSchema,
  operationResultSchema,
  operationWriteRequestSchema,
  pauseRequestSchema,
  scrapCodingRequestSchema,
  scrapReasonListSchema,
  scrapRecordSchema,
  terminalViewSchema,
  type CrewResult,
  type OperationResult,
  type PauseRequest,
  type ScrapRecordDto,
  type TerminalViewDto,
} from '@shopfloor/contracts/mes-api';
import type { z } from 'zod';
import { getJson, sendJson } from './client.ts';

// The operator terminal's routes of the MES (#177): the view of a work center, sign-on and
// sign-off, start, pause, resume and sign-off of an order operation, and scrap coding (#175's
// route, used here from the terminal).

const segment = encodeURIComponent;

/**
 * Query keys of the terminal: every one starts with `terminal` and names the user and the work
 * center, so nothing one operator read is ever served to the next (plan "Shared device").
 */
export const terminalKeys = {
  all: ['terminal'] as const,
  view: (user: string, workCenter: string) => ['terminal', user, workCenter, 'view'] as const,
  scrapReasons: (user: string) => ['terminal', user, 'scrap-reasons'] as const,
};

export function getTerminalView(
  workCenter: string,
  signal?: AbortSignal,
): Promise<TerminalViewDto> {
  return getJson(`/terminal/${segment(workCenter)}`, terminalViewSchema, signal);
}

export function signOn(workCenter: string): Promise<CrewResult> {
  return sendJson('POST', `/terminal/${segment(workCenter)}/sign-on`, {}, crewResultSchema);
}

export function signOff(workCenter: string): Promise<CrewResult> {
  return sendJson('POST', `/terminal/${segment(workCenter)}/sign-off`, {}, crewResultSchema);
}

export type OperationAction = 'start' | 'pause' | 'resume' | 'sign-off';

export interface OperationRef {
  readonly workCenter: string;
  readonly orderId: string;
  readonly operation: string;
}

export function operationWrite(
  ref: OperationRef,
  action: OperationAction,
  body: { readonly version: number } | PauseRequest,
): Promise<OperationResult> {
  const schema = action === 'pause' ? pauseRequestSchema : operationWriteRequestSchema;
  return sendJson(
    'POST',
    `/terminal/${segment(ref.workCenter)}/orders/${segment(ref.orderId)}/operations/${segment(ref.operation)}/${action}`,
    schema.parse(body),
    operationResultSchema,
  );
}

export function getScrapReasons(signal?: AbortSignal) {
  return getJson('/scrap-reasons', scrapReasonListSchema, signal);
}

export function codeScrap(
  id: number,
  body: z.input<typeof scrapCodingRequestSchema>,
): Promise<ScrapRecordDto> {
  return sendJson(
    'PUT',
    `/scrap-records/${String(id)}/coding`,
    scrapCodingRequestSchema.parse(body),
    scrapRecordSchema,
  );
}
