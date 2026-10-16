/**
 * The `shifts` module (#144, ADR-0025): shift instances as records per (plant epoch, shift key),
 * stored in the `shifts` schema; the shift report computed on read from the `oee`, `equipment`
 * and `alarms` modules' interfaces, with its finality and composite revision `{ inputs, content }`;
 * handover notes, versioned and never deleted, with an append-only audit. Other modules use only
 * what is exported here.
 *
 * - `Shifts.start()` (after equipment, alarms and oee) and `stop()`; `tick()` runs one pass of the
 *   plant clock check (tests).
 * - `Shifts.instance(date, shift, epoch?)`: the stored instance (newest epoch by default).
 * - `Shifts.report(date, shift, epoch?)`: the report; brings the stored finality and `inputs` up to
 *   what it read.
 * - `Shifts.notes(...)`, `note(id)`, `noteAudit(id)`, `createNote(...)`, `editNote(...)`:
 *   handover notes (`ShiftError` 'conflict' for a stale version or outside the handover window).
 * - `Shifts.onChange(listener)`: instance created, status and revision changes, note upserts.
 * - The shift calendar's functions (`shiftInstances`, `shiftBuckets`, …) are in the pure
 *   `@shopfloor/shift-calendar`, shared with `oee` (no module cycle).
 */
export {
  LONGEST_RECORDS,
  MAX_NOTES,
  NOTE_CATEGORIES,
  REPORT_BAD_ACTORS,
  ShiftError,
  Shifts,
  handoverWindow,
  production,
  revisionSteps,
} from './shifts.ts';
export type {
  HandoverAuditEntry,
  HandoverNote,
  MachineProduction,
  NoteCategory,
  NoteEdit,
  NoteRequest,
  ReportAlarmScope,
  ReportRevision,
  ShiftChange,
  ShiftErrorKind,
  ShiftRecord,
  ShiftReport,
  ShiftsLog,
  ShiftsOptions,
  ShiftsSources,
} from './shifts.ts';
export { SHIFTS_COLUMNS } from './tables.ts';
export type { InputRevisions, NoteContent, ShiftStatus, ShiftsTables } from './tables.ts';
