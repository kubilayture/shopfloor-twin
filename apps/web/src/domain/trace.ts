import {
  BLANK_OPERATION,
  GENEALOGY_LIMITS,
  type HoldRefDto,
  type LotRefDto,
  type TraceRecordDto,
  type TraceUnitDto,
} from '@shopfloor/contracts/mes-api';

// What the trace screens (#202) derive from the genealogy API's answers (ADR-0034): never a new
// fact, only how an answer reads. `null` (not reported) and `[]` (none) stay distinct.

/** A serial, lot or carton id the trace API takes in a path (`idParam` in the MES). */
export const TRACE_ID = new RegExp(`^[^/\\s]{1,${String(GENEALOGY_LIMITS.id)}}$`, 'u');

/**
 * A search the API takes: 1 to 128 characters, no U+0000. The router parses search values as
 * JSON, so a query of digits arrives as a number and is taken back as its text.
 */
export function validQuery(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') return undefined;
  const q = text.trim();
  if (q.length === 0 || q.length > GENEALOGY_LIMITS.id || q.includes('\u0000')) return undefined;
  return q;
}

/** A unit's key in a URL and a test id: `{epoch}-{partId}`. */
export const unitKey = (unit: { readonly epoch: number; readonly partId: number }): string =>
  `${String(unit.epoch)}-${String(unit.partId)}`;

export const UNIT_KEY = /^\d{1,15}-\d{1,15}$/;

/** Polling of a trace answer still moving: machines not final, or the unit or carton open. */
export const TRACE_POLL_MOVING_MS = 5_000;
/** Polling of a settled answer: a lot is still consumed, a hold's scope still grows. */
export const TRACE_POLL_SETTLED_MS = 30_000;
/** A forward trace of this many units or more is never read every 5 s (each read is large). */
export const LOT_FAST_POLL_UNITS = 500;

/**
 * How often a trace answer is read again (`refetchInterval`). Genealogy has no push (holds and
 * orders do, and read it again at once): while the answer is moving every 5 s, otherwise every
 * 30 s. Never after a failed read or a 404: the page offers **Try again**, and a push still reads
 * it again.
 */
export function tracePoll(failed: boolean, moving: boolean): number | false {
  if (failed) return false;
  return moving ? TRACE_POLL_MOVING_MS : TRACE_POLL_SETTLED_MS;
}

/** Whether a backward trace can still change: not final, or a unit still in work. */
export const serialMoving = (trace: { final: boolean; units: readonly TraceUnitDto[] }): boolean =>
  !trace.final || trace.units.some((unit) => unit.status === 'wip');

/**
 * Whether a forward trace is read every 5 s: not final and small. A lot keeps growing as long as
 * it is used, so a settled or large one is read every 30 s.
 */
export const lotMoving = (trace: { final: boolean; units: readonly unknown[] }): boolean =>
  !trace.final && trace.units.length < LOT_FAST_POLL_UNITS;

export const UNIT_STATUS_TEXT: Readonly<Record<TraceUnitDto['status'], string>> = {
  wip: 'In work',
  packed: 'Packed',
  scrapped: 'Scrapped',
  lost: 'Lost (its run ended)',
};

export const RESULT_TEXT: Readonly<Record<TraceRecordDto['result'], string>> = {
  good: 'Good',
  scrap: 'Scrap',
  rework: 'Rework',
};

export const HOLD_STATE_TEXT: Readonly<Record<HoldRefDto['state'], string>> = {
  open: 'Open',
  released: 'Released',
  rejected: 'Rejected',
};

export const SUBJECT_TEXT: Readonly<Record<HoldRefDto['subject']['kind'], string>> = {
  lot: 'Lot',
  serial: 'Serial',
  carton: 'Carton',
  order: 'Order',
};

/** `OP30`, or `OP30 (pass 2)` after a rework. */
export const operationText = (record: { operation: string; pass: number }): string =>
  record.pass > 1 ? `${record.operation} (pass ${String(record.pass)})` : record.operation;

/** A record's device operator: none, not reported (the fact had no operator field), or the id. */
export function operatorText(record: TraceRecordDto): string {
  if (record.operator !== null) return record.operator;
  return record.operatorReported ? 'None' : 'Not reported';
}

/**
 * The blank lots of a unit: the lots of its record at the routing's first operation
 * (`BLANK_OPERATION`, OP10: the CNC takes the blank and marks the serial), never whichever record
 * came first. `no-record` when the unit has no such record (a later operation's lots are never
 * taken for the blank); `null` when its fact reported no lot field; `[]` when it reported none.
 */
export function blankLots(unit: TraceUnitDto): readonly LotRefDto[] | null | 'no-record' {
  const records = unit.records.filter((record) => record.operation === BLANK_OPERATION);
  if (records.length === 0) return 'no-record';
  if (records.every((record) => record.lots === null)) return null;
  return distinctLots(records.flatMap((record) => record.lots ?? []));
}

/**
 * The components of a unit per pass: every record after the first operation that consumed a lot
 * or did not report its lots (`lots: null`, shown as not reported); records that reported none
 * (`[]`) are left out.
 */
export function componentPasses(
  unit: TraceUnitDto,
): readonly { readonly record: TraceRecordDto; readonly lots: readonly LotRefDto[] | null }[] {
  return unit.records
    .filter(
      (record) =>
        record.operation !== BLANK_OPERATION && (record.lots === null || record.lots.length > 0),
    )
    .map((record) => ({ record, lots: record.lots }));
}

/** Lots by lot id, first occurrence kept. */
export function distinctLots(lots: readonly LotRefDto[]): LotRefDto[] {
  const seen = new Set<string>();
  const kept: LotRefDto[] = [];
  for (const lot of lots) {
    if (seen.has(lot.lot)) continue;
    seen.add(lot.lot);
    kept.push(lot);
  }
  return kept;
}

/** Whether any hold named still blocks (open or rejected; a released one is listed, not held). */
export const blocking = (holds: readonly HoldRefDto[]): boolean =>
  holds.some((hold) => hold.state !== 'released');

/** A reading over its specification limit (the leak test fails it). */
export const overLimit = (reading: NonNullable<TraceRecordDto['reading']>): boolean =>
  reading.value > reading.upperLimit;

/**
 * The holds screen of #203. Plain `<a href>` links until that route exists in this app (a typed
 * `Link` can't name an unregistered route); #203 converts them to `Link`s.
 */
export const holdHref = (id: string): string => `/quality/holds/${encodeURIComponent(id)}`;
export const HOLDS_HREF = '/quality/holds';
