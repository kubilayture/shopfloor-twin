import { ZodError } from 'zod';
import { ApiError } from '../api/client.ts';

/** A failed write as a message for people (ADR-0023), by kind so tests and screens can tell. */
export interface WriteFailure {
  readonly kind: 'conflict' | 'refused' | 'invalid' | 'busy' | 'unavailable';
  readonly text: string;
}

export interface WriteTexts {
  /** How the message starts: `Not saved`, `Not acknowledged`, … */
  readonly not: string;
  /** What a 409 means for this write, and what the screen did about it. */
  readonly conflict: string;
  /** What the MES could not apply on a 422: `this coding`, `this shelf`, … */
  readonly what: string;
}

/** A failed write from the MES's problem details: 403, 405, 409, 415, 422, 429 and the rest. */
export function writeFailure(error: unknown, texts: WriteTexts): WriteFailure {
  if (error instanceof ZodError) {
    // The body failed the shared request schema before it was sent: say which field, briefly.
    const issues = error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
      .join('; ');
    return { kind: 'invalid', text: `${texts.not}: check the form (${issues}).` };
  }
  if (!(error instanceof ApiError)) {
    return { kind: 'invalid', text: error instanceof Error ? error.message : 'Unknown error' };
  }
  const detail = error.problem?.detail ?? error.message;
  switch (error.status) {
    case 409:
      return { kind: 'conflict', text: `${texts.not}: ${texts.conflict}` };
    case 403:
      return {
        kind: 'refused',
        text: `${texts.not}: the MES refused the write (403, ${detail}). Open the app through its own address; writes are accepted only from the MES's own origin.`,
      };
    case 405:
      return { kind: 'refused', text: `${texts.not}: writes are turned off on this MES (405).` };
    case 415:
      return {
        kind: 'refused',
        text: `${texts.not}: the MES accepts only JSON (415, ${detail}).`,
      };
    case 429:
      return {
        kind: 'busy',
        text: `${texts.not}: too many writes right now (429). Try again in ${String(error.retryAfter ?? 1)} s.`,
      };
    case 422:
      return {
        kind: 'invalid',
        text: `${texts.not}: the MES cannot apply ${texts.what} (422, ${detail}).`,
      };
    case 400:
    case 404:
    case 413:
      return { kind: 'invalid', text: `${texts.not} (${String(error.status)}): ${detail}` };
    case 0:
      return { kind: 'unavailable', text: `${texts.not}: the MES cannot be reached.` };
    default:
      return { kind: 'unavailable', text: `${texts.not} (${String(error.status)}): ${detail}` };
  }
}
