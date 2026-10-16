import {
  MES_API_LIMITS,
  codingRequestSchema,
  type CodingRequest,
  type DowntimeRecordDto,
  type ReasonCodes,
} from '@shopfloor/contracts/mes-api';
import { writeFailure, type WriteFailure } from './writes.ts';
import { isNewerRecord, type LiveDowntime } from '../live/live-cache.ts';
import { PLANT_TIME_ZONE } from './time.ts';

export const UNCODED = 'UNCODED';

export interface ReasonOption {
  readonly id: string;
  readonly name: string;
  readonly depth: number;
  /** Active and not UNCODED: the MES accepts it in a coding (422 otherwise). */
  readonly codable: boolean;
}

/** The reason tree in order (parents before children, as `/reason-codes` lists it), with depth. */
export function reasonOptions(codes: ReasonCodes): ReasonOption[] {
  return codes.reasons.map((reason) => ({
    id: reason.id,
    name: reason.name,
    depth: reason.id.split('/').length - 1,
    codable: reason.active && reason.id !== UNCODED,
  }));
}

export function reasonName(codes: ReasonCodes | undefined, id: string): string {
  return codes?.reasons.find((reason) => reason.id === id)?.name ?? id;
}

/** UNCODED records first, then by start (as `GET /downtime` orders them). */
export function compareRecords(a: DowntimeRecordDto, b: DowntimeRecordDto): number {
  if (a.uncoded !== b.uncoded) return a.uncoded ? -1 : 1;
  return Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id);
}

/** The record's end as shown: its end, or its length so far while open. */
export const recordEnd = (record: DowntimeRecordDto): number =>
  record.end === null ? Date.parse(record.start) + record.ms : Date.parse(record.end);

/**
 * The REST list with the pushed records applied (upserts by id; newer wins, `removed` deletes):
 * pushed records overlapping the range join the list, and the order is UNCODED first again.
 */
export function mergeRecords(
  rest: readonly DowntimeRecordDto[],
  live: LiveDowntime | undefined,
  range: { readonly from: number; readonly to: number },
): DowntimeRecordDto[] {
  if (!live) return [...rest];
  const byId = new Map(rest.map((record) => [record.id, record]));
  for (const { record, removed } of Object.values(live.records)) {
    const known = byId.get(record.id);
    if (removed) {
      byId.delete(record.id);
      continue;
    }
    if (known) {
      if (isNewerRecord(record, known)) byId.set(record.id, record);
    } else if (Date.parse(record.start) < range.to && recordEnd(record) > range.from) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()].sort(compareRecords);
}

// ---- The coding form ----

/** One stretch of the record in the form; an empty `reason` keeps the auto reason there. */
export interface DraftSegment {
  readonly from: number;
  readonly to: number;
  readonly reason: string;
  readonly comment: string;
}

/**
 * The form's starting segments: the record's operator codings with the stretches between them,
 * which keep the auto reason; one segment over the whole record when it has no codings.
 */
export function initialSegments(record: DowntimeRecordDto): DraftSegment[] {
  const start = Date.parse(record.start);
  const end = recordEnd(record);
  const segments: DraftSegment[] = [];
  let at = start;
  for (const coding of record.codings) {
    const from = Math.max(start, Date.parse(coding.from));
    const to = Math.min(end, Date.parse(coding.to));
    if (to <= from) continue;
    if (from > at) segments.push({ from: at, to: from, reason: '', comment: '' });
    segments.push({ from, to, reason: coding.reason, comment: coding.comment });
    at = to;
  }
  if (at < end || segments.length === 0) {
    segments.push({ from: at, to: Math.max(at, end), reason: '', comment: '' });
  }
  return segments;
}

/** A record's operator codings as one comparable value (what a draft is built from). */
export const codingsKey = (record: DowntimeRecordDto): string =>
  JSON.stringify(record.codings.map((c) => [c.from, c.to, c.reason, c.comment, c.codedBy]));

/** What a coding draft started from: the version read and the codings it was built from. */
export interface DraftBase {
  readonly version: number;
  readonly codings: string;
}

export const draftBase = (record: DowntimeRecordDto): DraftBase => ({
  version: record.version,
  codings: codingsKey(record),
});

/**
 * The version to write a draft with. While the record's codings are those the draft started
 * from, a newer version (a write to another record of the machine) is adopted. Once they
 * changed (someone coded this record meanwhile), undefined: the draft is stale and must be
 * reloaded, never sent with the newer version, which would silently replace that coding.
 */
export function writeVersion(base: DraftBase, record: DowntimeRecordDto): number | undefined {
  if (codingsKey(record) !== base.codings) return undefined;
  return Math.max(base.version, record.version);
}

/** Splits the segment that contains `at` into two (both keep its reason and comment). */
export function splitSegments(segments: readonly DraftSegment[], at: number): DraftSegment[] {
  return segments.flatMap((segment) =>
    at > segment.from && at < segment.to
      ? [
          { ...segment, to: at },
          { ...segment, from: at },
        ]
      : [segment],
  );
}

/** Joins segment `index` to the one before it (that one's reason and comment win). */
export function joinSegment(segments: readonly DraftSegment[], index: number): DraftSegment[] {
  if (index <= 0 || index >= segments.length) return [...segments];
  const previous = segments[index - 1];
  const current = segments[index];
  if (!previous || !current) return [...segments];
  return [
    ...segments.slice(0, index - 1),
    { ...previous, to: current.to },
    ...segments.slice(index + 1),
  ];
}

const offsetFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: PLANT_TIME_ZONE,
  timeZoneName: 'longOffset',
});

/** The plant zone's offset from UTC at an instant, in ms (Istanbul is +03:00 all year). */
function plantOffsetMs(at: number): number {
  const name = offsetFormat.formatToParts(at).find((part) => part.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? '');
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === '-' ? -1 : 1) * minutes * 60_000;
}

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: PLANT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * A plant clock time (`HH:MM` or `HH:MM:SS`, as a time input gives it) inside the record, as an
 * instant: the one on the record's first or second plant day (a night shift crosses midnight)
 * that lies strictly inside it. Undefined when the time is malformed or outside the record.
 */
export function plantTimeInRecord(text: string, record: DowntimeRecordDto): number | undefined {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!match) return undefined;
  const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
  const start = Date.parse(record.start);
  const end = recordEnd(record);
  const [year, month, day] = dayFormat.format(start).split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  for (const extraDay of [0, 1]) {
    const wall = Date.UTC(year, month - 1, day + extraDay, hours, minutes, seconds);
    const instant = wall - plantOffsetMs(wall);
    if (instant > start && instant < end) return instant;
  }
  return undefined;
}

export interface Draft {
  readonly segments: readonly DraftSegment[];
}

/** What is wrong with the form, for people; empty when it can be sent. */
export function validateDraft(
  draft: Draft,
  record: DowntimeRecordDto,
  reasons: readonly ReasonOption[],
): string[] {
  const errors: string[] = [];
  const start = Date.parse(record.start);
  const end = recordEnd(record);
  const coded = draft.segments.filter((segment) => segment.reason !== '');
  if (coded.length > MES_API_LIMITS.codingSegments) {
    errors.push(`At most ${String(MES_API_LIMITS.codingSegments)} coded segments.`);
  }
  let previousEnd = start;
  draft.segments.forEach((segment, index) => {
    const name = `Segment ${String(index + 1)}`;
    if (segment.to <= segment.from) errors.push(`${name} is empty.`);
    if (segment.from < start || segment.to > end) errors.push(`${name} lies outside the record.`);
    if (index > 0 && segment.from < previousEnd) errors.push(`${name} overlaps the one before.`);
    previousEnd = Math.max(previousEnd, segment.to);
    if (segment.reason !== '') {
      const reason = reasons.find((option) => option.id === segment.reason);
      if (!reason?.codable) errors.push(`${name}: choose an active reason (not "Not coded").`);
    }
    if (segment.comment.trim().length > MES_API_LIMITS.codingComment) {
      errors.push(
        `${name}: the comment may have at most ${String(MES_API_LIMITS.codingComment)} characters.`,
      );
    }
  });
  return errors;
}

/**
 * The `PUT /downtime/{id}/coding` body: the segments with a reason (others keep the auto
 * reason) and the record's `version` as read; the MES records the session's user as the coder
 * (#170). Checked with the shared schema.
 */
export function codingBody(draft: Draft, version: number): CodingRequest {
  const body: CodingRequest = {
    segments: draft.segments
      .filter((segment) => segment.reason !== '')
      .map((segment) => ({
        from: new Date(segment.from).toISOString(),
        to: new Date(segment.to).toISOString(),
        reason: segment.reason,
        ...(segment.comment.trim() === '' ? {} : { comment: segment.comment.trim() }),
      })),
    version,
  };
  codingRequestSchema.parse(body);
  return body;
}

export type { WriteFailure };

/** A failed coding write as a message for people, from the MES's problem details (ADR-0023). */
export function codingFailure(error: unknown): WriteFailure {
  return writeFailure(error, {
    not: 'Not saved',
    what: 'this coding',
    conflict:
      'the codings of this machine changed since the record was read (another coding of the same machine, or a re-cut). The record was reloaded; check it and code again.',
  });
}
