import type { NOTE_CATEGORIES } from '@shopfloor/contracts/mes-api';
import {
  MES_API_LIMITS,
  type AlarmKpiBucketDto,
  type HandoverAuditEntryDto,
  type HandoverNoteDto,
  type OeeBucketDto,
  type ShiftRecordDto,
  type ShiftReportDto,
} from '@shopfloor/contracts/mes-api';
import { ApiError } from '../api/client.ts';
import { pickBucket } from './oee.ts';
import { writeFailure, type WriteFailure } from './writes.ts';

/**
 * The shift report page (#146, ADR-0025). Every value shown is the API's: integers, exact
 * fractions and four-decimal strings. The only arithmetic here is on integer counts (a sum of
 * scrap cycles, a count of note writes), never floating point on a ratio.
 */

export type ShiftStatus = ShiftRecordDto['status'];
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

export const STATUS_TEXT: Readonly<Record<ShiftStatus, string>> = {
  running: 'Running',
  ended: 'Ended, not final',
  final: 'Final',
};

/** Whether the report may still change through late data (`provisional`) or is `final`. */
export const finalityText = (record: Pick<ShiftRecordDto, 'final'>): string =>
  record.final ? 'Final' : 'Provisional';

export const CATEGORY_LABELS: Readonly<Record<NoteCategory, string>> = {
  safety: 'Safety',
  quality: 'Quality',
  equipment: 'Equipment',
  material: 'Material',
  general: 'General',
};

const STATUS_RANK: Readonly<Record<ShiftStatus, number>> = { running: 0, ended: 1, final: 2 };

/** A shift instance's identity: one per (plant epoch, shift key). */
export const instanceKey = (epoch: number, key: string): string => `${String(epoch)}~${key}`;

/** `2026-10-15/A` → `2026-10-15-A` (test ids). */
export const shiftTestKey = (key: string): string => key.replace('/', '-');

/**
 * The MES's push rule (ADR-0025): an instance is newer when its status, `inputs` and `content`
 * are each at least as high as the known one's and one is higher. Anything else (equal, or a
 * copy behind in one counter) never replaces what is known.
 */
export function isNewerShift(
  incoming: Pick<ShiftRecordDto, 'status' | 'revision'>,
  known: Pick<ShiftRecordDto, 'status' | 'revision'>,
): boolean {
  const status = STATUS_RANK[incoming.status] - STATUS_RANK[known.status];
  const inputs = incoming.revision.inputs - known.revision.inputs;
  const content = incoming.revision.content - known.revision.content;
  if (status < 0 || inputs < 0 || content < 0) return false;
  return status > 0 || inputs > 0 || content > 0;
}

/** `Revision 2 / 5`: inputs, then content. */
export const revisionText = (record: Pick<ShiftRecordDto, 'revision'>): string =>
  `inputs ${String(record.revision.inputs)}, content ${String(record.revision.content)}`;

export interface ChangesAfterFinal {
  /** Input revision steps since final (`revision.inputs`). */
  readonly inputs: number;
  /**
   * Content steps since final: `revision.content` less the note writes before `finalAt` (each
   * note write is one content step, before final too; recodes and acknowledgements count only
   * after final, ADR-0025).
   */
  readonly content: number;
}

/** How a final report changed since it became final; undefined while it is not final. */
export function changesAfterFinal(
  report: Pick<ShiftReportDto, 'final' | 'finalAt' | 'revision' | 'notes'>,
): ChangesAfterFinal | undefined {
  if (!report.final || report.finalAt === null) return undefined;
  const finalAt = Date.parse(report.finalAt);
  const before = report.notes
    .flatMap((entry) => entry.history)
    .filter((entry) => Date.parse(entry.at) < finalAt).length;
  return {
    inputs: report.revision.inputs,
    content: Math.max(0, report.revision.content - before),
  };
}

// ---- Live numbers (`oee:<id>`, `alarm-kpi:<scope>`) ----

/**
 * The OEE bucket to show for one machine or work center of the report: the pushed shift bucket
 * when it is this shift of this epoch and not behind the report's (`pickBucket`), else the
 * report's. `live` says the pushed one is shown.
 */
export function liveOee(
  rest: OeeBucketDto | undefined,
  pushed: OeeBucketDto | null | undefined,
  report: Pick<ShiftRecordDto, 'key' | 'epoch'>,
): { readonly bucket: OeeBucketDto | undefined; readonly live: boolean } {
  const usable =
    pushed?.bucket === 'shift' &&
    pushed.key === report.key &&
    pushed.members.every((member) => member.epoch === report.epoch)
      ? pushed
      : undefined;
  const bucket = pickBucket(rest, usable);
  return { bucket, live: bucket !== undefined && bucket === usable && bucket !== rest };
}

/** The alarm KPI bucket of one scope, as `liveOee`: the pushed one of this shift and epoch. */
export function liveAlarmKpi(
  rest: AlarmKpiBucketDto | null,
  pushed: AlarmKpiBucketDto | null | undefined,
  report: Pick<ShiftRecordDto, 'key' | 'epoch'>,
): { readonly bucket: AlarmKpiBucketDto | undefined; readonly live: boolean } {
  const usable =
    pushed?.bucket === 'shift' && pushed.key === report.key && pushed.epoch === report.epoch
      ? pushed
      : undefined;
  const own = rest ?? undefined;
  const bucket = pickBucket(own, usable);
  return { bucket, live: bucket !== undefined && bucket === usable && bucket !== own };
}

export interface ProductionRow {
  readonly equipment: string;
  readonly produced: number;
  readonly good: number;
  readonly scrap: number;
  readonly rework: number;
  /** From the pushed OEE bucket's totals (the API's counts), not the report read. */
  readonly live: boolean;
}

export interface Production {
  readonly machines: readonly ProductionRow[];
  readonly finished: { readonly equipment: string | null; readonly good: number | null };
  readonly scrap: number;
  readonly live: boolean;
}

/**
 * The production section: the report's counts, or for a machine whose OEE bucket is the pushed
 * one, that bucket's totals (the same cycles the report counts, as the MES sent them). The total
 * scrap is the report's, or the integer sum of the rows once one of them is live.
 */
export function production(
  report: Pick<ShiftReportDto, 'production'>,
  machines: readonly string[],
  bucketOf: (id: string) => { readonly bucket: OeeBucketDto | undefined; readonly live: boolean },
): Production {
  const reported = new Map(report.production.machines.map((row) => [row.equipment, row]));
  const rows: ProductionRow[] = [];
  for (const id of machines) {
    const { bucket, live } = bucketOf(id);
    if (live && bucket) {
      const { produced, good, scrap, rework } = bucket.result.totals;
      rows.push({ equipment: id, produced, good, scrap, rework, live: true });
      continue;
    }
    const row = reported.get(id);
    if (row) {
      const { produced, good, scrap, rework } = row;
      rows.push({ equipment: id, produced, good, scrap, rework, live: false });
    }
  }
  const live = rows.some((row) => row.live);
  const finishedId = report.production.finished.equipment;
  const finishedRow =
    finishedId === null ? undefined : rows.find((r) => r.equipment === finishedId);
  return {
    machines: rows,
    finished: {
      equipment: finishedId,
      good:
        finishedId === null
          ? null
          : finishedRow?.live
            ? finishedRow.good
            : report.production.finished.good,
    },
    scrap: live ? rows.reduce((sum, row) => sum + row.scrap, 0) : report.production.scrap,
    live,
  };
}

// ---- Handover notes ----

export interface NoteWithHistory {
  readonly note: HandoverNoteDto;
  readonly history: readonly HandoverAuditEntryDto[];
}

/**
 * The notes of one instance from every source (the report, the notes read, pushes and write
 * answers): per id the highest `version` wins; notes of another (epoch, shift) are ignored; by
 * creation.
 */
export function mergeNotes(
  rest: readonly NoteWithHistory[],
  pushed: Readonly<Record<string, HandoverNoteDto>> | undefined,
  epoch: number,
  key: string,
): HandoverNoteDto[] {
  const byId = new Map<number, HandoverNoteDto>();
  const add = (note: HandoverNoteDto) => {
    if (note.epoch !== epoch || note.shiftKey !== key) return;
    const known = byId.get(note.id);
    if (!known || note.version > known.version) byId.set(note.id, note);
  };
  for (const entry of rest) add(entry.note);
  for (const note of Object.values(pushed ?? {})) add(note);
  return [...byId.values()].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id,
  );
}

/** At most this many notes per shift instance (422 beyond). */
export const NOTE_LIMIT = MES_API_LIMITS.notesPerShift;

/**
 * What an edit started from. A draft keeps the version it started from: once the note moves on
 * (another user's edit, pushed or read), the draft is stale and is never sent with the newer
 * version, which would silently replace that edit.
 */
export interface NoteDraft {
  readonly category: NoteCategory;
  readonly text: string;
  readonly retracted: boolean;
  readonly version: number;
}

export const draftOf = (note: HandoverNoteDto): NoteDraft => ({
  category: note.category,
  text: note.text,
  retracted: note.retracted,
  version: note.version,
});

export const isStaleDraft = (draft: NoteDraft, note: HandoverNoteDto): boolean =>
  note.version !== draft.version;

export type NoteFailureKind = WriteFailure['kind'] | 'stale' | 'closed' | 'limit';

export interface NoteFailure {
  readonly kind: NoteFailureKind;
  readonly text: string;
}

const CLOSED = /^handover (closed|not open)/;
const LIMIT = /at most \d+ notes/;

/** A failed note write as a message for people: stale, handover closed, limit, or the rest. */
export function noteFailure(error: unknown): NoteFailure {
  if (error instanceof ApiError) {
    const detail = error.problem?.detail ?? '';
    if (error.status === 409 && CLOSED.test(detail)) {
      return {
        kind: 'closed',
        text: `Not saved: the handover window is closed (${detail}). Notes can be written from the shift's start until the end of the following shift, in plant time.`,
      };
    }
    if (error.status === 409) {
      return {
        kind: 'stale',
        text: 'Not saved: someone else changed this note since you started editing. Your draft was not sent and is kept below; reload the note to see their version, then edit again.',
      };
    }
    if (error.status === 422 && LIMIT.test(detail)) {
      return {
        kind: 'limit',
        text: `Not saved: this shift already has ${String(NOTE_LIMIT)} notes, the most allowed. Edit an existing note instead.`,
      };
    }
  }
  return writeFailure(error, {
    not: 'Not saved',
    what: 'this note',
    conflict: 'the note changed meanwhile; it was read again.',
  });
}
