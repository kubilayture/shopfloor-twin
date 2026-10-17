/**
 * The pure part of the execution module (#175, ADR-0031): a unit from its cycle facts, whether a
 * CNC holds a blank no cycle fact shows yet, an order's quantities and material per operation, and
 * the completion of its operations (plan H1, H2). No database, no clock: the module and the tests
 * feed facts in and compare.
 */
import type { RoutingViolation, UnitStatus } from './tables.ts';

/** The routing as the execution module follows it. */
export interface RoutingModel {
  /** Operations in routing order (OP10 … OP50). */
  readonly operations: readonly string[];
  /** The leak test, whose first failure sends a unit back (`rework`), the second scraps it. */
  readonly test: string;
  /** Where a unit sent back goes again (OP30): pass 2 there and at the test. */
  readonly back: string;
}

/** A cycle fact as the derivation needs it. */
export interface UnitFact {
  readonly equipment: string;
  readonly epoch: number;
  readonly seq: number;
  /** Plant time, ms. */
  readonly at: number;
  readonly product: string;
  readonly partId: number;
  readonly serial: string;
  readonly result: 'good' | 'scrap' | 'rework';
  readonly reason: string | null;
}

/** A job's `started` fact on a CNC. */
export interface JobStart {
  readonly seq: number;
  readonly commandId: string;
  readonly orderId: string;
}

export interface RecordOf {
  readonly equipment: string;
  readonly epoch: number;
  readonly seq: number;
  readonly operation: string;
  readonly pass: number;
  readonly at: number;
  readonly result: 'good' | 'scrap' | 'rework';
  readonly reason: string | null;
}

export interface BuiltUnit {
  readonly epoch: number;
  readonly partId: number;
  readonly serial: string | null;
  readonly product: string;
  readonly orderId: string | null;
  readonly commandId: string | null;
  readonly status: Exclude<UnitStatus, 'lost'>;
  /** `after:OPxx`, `rework:OPxx` or `done`. */
  readonly position: string;
  readonly lastAt: number;
  readonly terminalAt: number | null;
  /** The records in routing order (by plant time, then routing position, then seq). */
  readonly records: readonly RecordOf[];
  /**
   * A routing break not proven yet (judged by the caller): the operation whose fact would explain
   * it, and the time of the record that showed it.
   */
  readonly suspect: {
    readonly kind: 'missing-predecessor' | 'repeated';
    readonly operation: string;
    readonly before: number;
  } | null;
  /** A violation the records prove by themselves. */
  readonly violation: Extract<RoutingViolation, 'after-terminal'> | null;
}

/**
 * A unit from every cycle fact of its (epoch, partId): passes (a leak-test `rework` opens pass 2
 * at the rework operation and the test), its order (the job whose `started` fact is the latest
 * below its OP10 cycle on that CNC), status and position, and what breaks the routing: a record
 * after the unit's terminal one (a violation at once), or a record where another operation was
 * expected, later in the routing (`missing-predecessor`) or earlier (`repeated`), a suspect the
 * caller judges once the machines of the expected operation are final through its time (a fact
 * still on its way may explain it; facts are never refused). Deterministic whatever order the facts
 * arrived in.
 */
export function buildUnit(
  facts: readonly UnitFact[],
  operationOf: (equipment: string) => string | undefined,
  startsOf: (equipment: string) => readonly JobStart[],
  model: RoutingModel,
): BuiltUnit {
  const first = facts[0];
  if (!first) throw new RangeError('a unit needs at least one cycle fact');
  const position = (op: string): number => {
    const index = model.operations.indexOf(op);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const sorted = [...facts].sort(
    (a, b) =>
      a.at - b.at ||
      position(operationOf(a.equipment) ?? '') - position(operationOf(b.equipment) ?? '') ||
      (a.equipment < b.equipment ? -1 : a.equipment > b.equipment ? 1 : 0) ||
      a.seq - b.seq,
  );
  const firstOperation = model.operations[0] ?? 'OP10';
  const lastOperation = model.operations.at(-1) ?? 'OP50';
  const records: RecordOf[] = [];
  let expected = firstOperation;
  let reworks = 0;
  let terminal: { status: 'packed' | 'scrapped'; at: number } | undefined;
  let suspect: BuiltUnit['suspect'] = null;
  let violation: BuiltUnit['violation'] = null;
  let serial: string | null = null;
  let job: JobStart | undefined;
  let attributed = false;
  let last: { operation: string; result: string } | undefined;
  for (const fact of sorted) {
    const operation = operationOf(fact.equipment) ?? '?';
    const pass = operation === model.back || operation === model.test ? reworks + 1 : 1;
    records.push({
      equipment: fact.equipment,
      epoch: fact.epoch,
      seq: fact.seq,
      operation,
      pass,
      at: fact.at,
      result: fact.result,
      reason: fact.reason,
    });
    if (fact.serial !== '') serial = fact.serial;
    if (operation === firstOperation && !attributed) {
      attributed = true;
      job = startsOf(fact.equipment)
        .filter((s) => s.seq < fact.seq)
        .reduce<JobStart | undefined>(
          (latest, s) => (!latest || s.seq > latest.seq ? s : latest),
          undefined,
        );
    }
    if (terminal) {
      violation ??= 'after-terminal';
    } else if (operation !== expected) {
      // Not proven yet: a fact of the expected operation still on its way (a leak-test rework
      // before a second OP30 pass, an OP20 cycle before OP30) would make the routing whole.
      suspect ??= {
        kind: position(operation) > position(expected) ? 'missing-predecessor' : 'repeated',
        operation: expected,
        before: fact.at,
      };
    }
    if (!terminal) {
      if (fact.result === 'scrap') {
        terminal = { status: 'scrapped', at: fact.at };
      } else if (fact.result === 'rework') {
        reworks++;
        expected = model.back;
      } else if (operation === lastOperation) {
        terminal = { status: 'packed', at: fact.at };
      } else {
        expected = model.operations[position(operation) + 1] ?? lastOperation;
      }
    }
    last = { operation, result: fact.result };
  }
  const lastAt = Math.max(...sorted.map((f) => f.at));
  return {
    epoch: first.epoch,
    partId: first.partId,
    serial,
    product: first.product,
    orderId: job?.orderId ?? null,
    commandId: job?.commandId ?? null,
    status: terminal?.status ?? 'wip',
    position: terminal
      ? 'done'
      : last?.result === 'rework'
        ? `rework:${model.back}`
        : `after:${last?.operation ?? firstOperation}`,
    lastAt,
    terminalAt: terminal?.at ?? null,
    records,
    suspect,
    violation,
  };
}

/** A state fact of a CNC after a job's last OP10 cycle (or its `started` fact), by `seq`. */
export interface StateAfter {
  readonly state: string;
  readonly cause: string | null;
}

/**
 * Whether a CNC holds a blank whose OP10 cycle has not completed, judged from its state facts
 * after its last OP10 cycle (or the job's `started` fact) in `seq` order (ADR-0031): the last
 * decisive state wins. `Running` holds one; `Starved`, `Blocked` (the finished part waits, no new
 * blank), a changeover `Setup` and `Idle` for want of an order hold none. Breaks, shift ends,
 * stops, failures and a missing operator keep whatever the machine held, so they are skipped. With
 * no decisive state the CNC was running when its last cycle ended and took the next blank at once
 * (no state change, no fact).
 */
export function holdsBlank(states: readonly StateAfter[]): boolean {
  for (let i = states.length - 1; i >= 0; i--) {
    const { state, cause } = states[i] ?? { state: '', cause: null };
    if (state === 'Running') return true;
    if (state === 'Starved' || state === 'Blocked') return false;
    if (state === 'Setup' && (cause ?? '').startsWith('CHANGEOVER')) return false;
    if (state === 'Idle' && (cause === 'NO-ORDER' || cause === 'SCHEDULE-COMPLETE')) return false;
  }
  return true;
}

/** A BOM line as the backflush reads it. */
export interface BomLine {
  readonly material: string;
  readonly operation: string;
  readonly quantityPerUnit: number;
  readonly usage: 'standard' | 'rework';
}

/** Quantities of one order operation: completed cycles of every pass. */
export interface OperationTotals {
  readonly operation: string;
  readonly in: number;
  readonly good: number;
  /** Scrap per reason (the cycle fact's). */
  readonly scrap: Readonly<Record<string, number>>;
  /** Cycles that sent a unit back (`rework` results). */
  readonly rework: number;
  /** Backflushed material per material id. */
  readonly material: Readonly<Record<string, number>>;
}

const sortedRecord = (map: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * An order's quantities per routing operation from its units' records (plan "Quantities and
 * material", H2): in = good + scrap + rework over every pass; material backflushed from the BOM per
 * completed cycle, the `standard` lines of the operation on a first pass and its `rework` lines on
 * a later one (a blank with each OP10 cycle, whatever its result; components with each OP30 cycle).
 */
export function orderTotals(
  records: readonly {
    readonly operation: string;
    readonly pass: number;
    readonly result: 'good' | 'scrap' | 'rework';
    readonly reason: string | null;
  }[],
  bom: readonly BomLine[],
  operations: readonly string[],
): OperationTotals[] {
  return operations.map((operation) => {
    const mine = records.filter((r) => r.operation === operation);
    const scrap = new Map<string, number>();
    const material = new Map<string, number>();
    for (const record of mine) {
      if (record.result === 'scrap') {
        const reason = record.reason ?? 'UNKNOWN';
        scrap.set(reason, (scrap.get(reason) ?? 0) + 1);
      }
      const usage = record.pass === 1 ? 'standard' : 'rework';
      for (const line of bom) {
        if (line.operation !== operation || line.usage !== usage) continue;
        material.set(line.material, (material.get(line.material) ?? 0) + line.quantityPerUnit);
      }
    }
    return {
      operation,
      in: mine.length,
      good: mine.filter((r) => r.result === 'good').length,
      scrap: sortedRecord(scrap),
      rework: mine.filter((r) => r.result === 'rework').length,
      material: sortedRecord(material),
    };
  });
}

/** A unit as completion reads it. */
export interface CompletionUnit {
  readonly status: UnitStatus;
  readonly records: readonly {
    readonly equipment: string;
    readonly epoch: number;
    readonly seq: number;
    readonly operation: string;
    readonly at: number;
    readonly result: 'good' | 'scrap' | 'rework';
  }[];
}

/**
 * When each operation of an order is complete (plan H1), or null: only once no unit can come back
 * to it, from final data only.
 * - OP10 when its jobs are complete (`jobsDone`, judged by the caller: every job `completed` and
 *   its CNC final through that fact, every OP10 cycle of the jobs a unit);
 * - OP20 when every unit passed it for good or was scrapped at OP10;
 * - the rework operation and the test only once every unit passed the test for good or was
 *   scrapped (a unit with one failure is still open for both);
 * - the last operation when every unit is packed or scrapped.
 * A unit lost with its device run counts as done (it contributes what it did). Every record an
 * operation's completion rests on must be at or below its machine's final-through (`settled`).
 * The time is the latest record of the operation (and of the test for the rework operation, and
 * vice versa), never before the previous operation's.
 */
export function completion(
  units: readonly CompletionUnit[],
  jobsDone: boolean,
  settled: (record: { equipment: string; epoch: number; seq: number }) => boolean,
  model: RoutingModel,
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const [firstOperation = 'OP10', ...rest] = model.operations;
  const lastOperation = model.operations.at(-1) ?? 'OP50';
  const records = units.flatMap((u) => u.records);
  const latest = (operations: readonly string[]): number =>
    Math.max(
      Number.NEGATIVE_INFINITY,
      ...records.filter((r) => operations.includes(r.operation)).map((r) => r.at),
    );
  const allSettled = (operations: readonly string[]): boolean =>
    records.filter((r) => operations.includes(r.operation)).every(settled);
  const passedGood = (unit: CompletionUnit, operation: string): boolean =>
    unit.records.some((r) => r.operation === operation && r.result === 'good');
  const scrappedAt = (unit: CompletionUnit, operation?: string): boolean =>
    unit.records.some(
      (r) => r.result === 'scrap' && (operation === undefined || r.operation === operation),
    );
  let previous: number | null = null;
  if (jobsDone && allSettled([firstOperation])) {
    const at = latest([firstOperation]);
    previous = Number.isFinite(at) ? at : null;
  }
  result.set(firstOperation, previous);
  for (const operation of rest) {
    const group =
      operation === model.back || operation === model.test ? [model.back, model.test] : [operation];
    let done = previous !== null;
    if (done) {
      for (const unit of units) {
        if (unit.status === 'lost') continue;
        const ok =
          operation === lastOperation
            ? unit.status === 'packed' || unit.status === 'scrapped'
            : group.length > 1
              ? passedGood(unit, model.test) || scrappedAt(unit)
              : passedGood(unit, operation) || scrappedAt(unit);
        if (!ok) {
          done = false;
          break;
        }
      }
    }
    if (done && !allSettled(group)) done = false;
    const at = done ? Math.max(previous ?? Number.NEGATIVE_INFINITY, latest(group)) : null;
    result.set(operation, at);
    previous = at;
  }
  return result;
}

/** Totals as a confirmation carries them, and the comparison of two. */
export interface ConfirmationTotals {
  readonly yield: number;
  readonly scrap: Readonly<Record<string, number>>;
  readonly reworkPasses: number;
  readonly material: Readonly<Record<string, number>>;
}

export const confirmationTotals = (totals: OperationTotals): ConfirmationTotals => ({
  yield: totals.good,
  scrap: totals.scrap,
  reworkPasses: totals.rework,
  material: totals.material,
});
