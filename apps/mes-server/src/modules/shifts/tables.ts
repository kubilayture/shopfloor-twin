import type { ColumnType, JSONColumnType } from 'kysely';

/** Read as a Date; written as a Date or an ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
/** Defaults in the database. */
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** A generated id or a column only the database writes. */
type Generated<T> = ColumnType<T, never, never>;

export type ShiftStatus = 'running' | 'ended' | 'final';

/** The input revisions a report counts, by input (`oee:{equipment}:{hour}`, `alarm:{scope}:{hour}`). */
export type InputRevisions = Record<string, number>;

/** A handover note's content, as the audit records it (`before`, `after`). */
export interface NoteContent {
  readonly category: string;
  readonly text: string;
  readonly retracted: boolean;
}

/** One shift instance per (plant epoch, shift key) (#144, migration 0014). */
export interface ShiftInstanceTable {
  epoch: number;
  shift_key: string;
  shift_date: string;
  shift_id: string;
  start_time: Timestamp;
  end_time: Timestamp;
  /** Written as JSON text (pg would send a JS array as a PostgreSQL array). */
  breaks: JSONColumnType<{ start: string; end: string }[]>;
  status: ShiftStatus;
  final_at: NullableTimestamp;
  final_inputs: JSONColumnType<InputRevisions | null, string | null | undefined, string | null>;
  seen_inputs: JSONColumnType<InputRevisions | null, string | null | undefined, string | null>;
  inputs_revision: ColumnType<number, number | undefined, number>;
  content_revision: ColumnType<number, number | undefined, number>;
  /** `content_revision` when the report became final (#163, migration 0015); null until then. */
  content_at_final: ColumnType<number | null, number | null | undefined, number | null>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** A handover note's current version (#144). */
export interface HandoverNoteTable {
  id: Generated<number>;
  epoch: number;
  shift_key: string;
  category: string;
  text: string;
  created_by: string;
  author: string;
  retracted: ColumnType<boolean, boolean | undefined, boolean>;
  version: ColumnType<number, number | undefined, number>;
  created_at: DefaultTimestamp;
  created_plant_at: Timestamp;
  updated_at: DefaultTimestamp;
  updated_plant_at: Timestamp;
}

/**
 * Every create and edit of a note until #169, append-only; frozen since (migration 0018): the
 * notes' audit is `identity.audit_log`.
 */
export interface HandoverAuditTable {
  id: Generated<number>;
  note_id: number;
  epoch: number;
  shift_key: string;
  action: 'created' | 'edited';
  before: JSONColumnType<NoteContent | null, string | null, never>;
  after: JSONColumnType<NoteContent, string, never>;
  actor: string;
  authenticated: ColumnType<boolean, boolean | undefined, never>;
  at: ColumnType<Date, Date | string | undefined, never>;
  plant_at: ColumnType<Date, Date | string, never>;
  request_id: string | null;
  version: number;
}

/**
 * Why a crew row ended: signed off at the terminal, the terminal session ended, the shift ended,
 * or a new sign-on of the same user there from another session replaced it (#177).
 */
export type CrewEndReason = 'sign-off' | 'session-ended' | 'shift-ended' | 'replaced';

/** Who is signed on at a work center during a shift instance (#169; written from #177). */
export interface CrewAssignmentTable {
  id: Generated<number>;
  user_id: number;
  username: string;
  work_center: string;
  epoch: number;
  shift_key: string;
  session_id: string | null;
  from_at: Timestamp;
  from_plant_at: Timestamp;
  to_at: Date | null;
  to_plant_at: Date | null;
  end_reason: CrewEndReason | null;
}

export interface ShiftsTables {
  'shifts.shift_instance': ShiftInstanceTable;
  'shifts.handover_note': HandoverNoteTable;
  'shifts.handover_audit': HandoverAuditTable;
  'shifts.crew_assignment': CrewAssignmentTable;
}

export const SHIFTS_COLUMNS = {
  'shifts.shift_instance': [
    'epoch',
    'shift_key',
    'shift_date',
    'shift_id',
    'start_time',
    'end_time',
    'breaks',
    'status',
    'final_at',
    'final_inputs',
    'seen_inputs',
    'inputs_revision',
    'content_revision',
    'created_at',
    'updated_at',
    'content_at_final',
  ],
  'shifts.handover_note': [
    'id',
    'epoch',
    'shift_key',
    'category',
    'text',
    'created_by',
    'author',
    'retracted',
    'version',
    'created_at',
    'created_plant_at',
    'updated_at',
    'updated_plant_at',
  ],
  'shifts.handover_audit': [
    'id',
    'note_id',
    'epoch',
    'shift_key',
    'action',
    'before',
    'after',
    'actor',
    'authenticated',
    'at',
    'plant_at',
    'request_id',
    'version',
  ],
  'shifts.crew_assignment': [
    'id',
    'user_id',
    'username',
    'work_center',
    'epoch',
    'shift_key',
    'session_id',
    'from_at',
    'from_plant_at',
    'to_at',
    'to_plant_at',
    'end_reason',
  ],
} as const;
