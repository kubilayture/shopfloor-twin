/**
 * Pure comparisons of the reconciliation (#100): the MES's time per state against the simulator's
 * ground truth, and the cut of every stored piece. Kept free of I/O so they are unit tested.
 */
import type { ShiftSegment } from '@shopfloor/shift-calendar';

export const HOUR = 3_600_000;

/** The machine states, in the simulator's order (docs/simulation-model.md). */
export const MACHINE_STATES = [
  'Off',
  'Idle',
  'Running',
  'Stopped',
  'Starved',
  'Blocked',
  'Setup',
  'Down',
  'PlannedStop',
  'Maintenance',
] as const;

export type StateMs = Record<string, number>;

/** One row of `GET /api/v1/shifts/{date}/{shift}/totals`. */
export interface TotalsRow {
  readonly equipment: string;
  readonly epoch: number;
  readonly state: string;
  readonly ms: number;
  readonly provisionalMs: number;
}

export interface MesTotals {
  /** Per machine, every state (zero when absent), for the epoch asked for. */
  readonly byMachine: Record<string, StateMs>;
  /** Per machine, the part of its time stored as provisional (the open interval). */
  readonly provisionalMs: Record<string, number>;
  /** Rows of other epochs, or of machines or states the ground truth doesn't know. */
  readonly unexpected: readonly TotalsRow[];
}

const zero = (): StateMs => Object.fromEntries(MACHINE_STATES.map((state) => [state, 0]));

/** The MES's shift totals in the ground truth's shape, for one epoch and the given machines. */
export function mesTotals(
  rows: readonly TotalsRow[],
  epoch: number,
  machines: readonly string[],
): MesTotals {
  const byMachine = Object.fromEntries(machines.map((id) => [id, zero()]));
  const provisionalMs = Object.fromEntries(machines.map((id) => [id, 0]));
  const unexpected: TotalsRow[] = [];
  for (const row of rows) {
    const states = byMachine[row.equipment];
    if (row.epoch !== epoch || !states || !(row.state in states)) {
      unexpected.push(row);
      continue;
    }
    states[row.state] = (states[row.state] ?? 0) + row.ms;
    provisionalMs[row.equipment] = (provisionalMs[row.equipment] ?? 0) + row.provisionalMs;
  }
  return { byMachine, provisionalMs, unexpected };
}

export interface Difference {
  readonly machine: string;
  readonly state: string;
  readonly truth: number;
  readonly mes: number;
}

/** Every (machine, state) whose milliseconds differ; empty when they are equal. */
export function differences(
  truth: Readonly<Record<string, StateMs>>,
  mes: Readonly<Record<string, StateMs>>,
): Difference[] {
  const result: Difference[] = [];
  const machines = [...new Set([...Object.keys(truth), ...Object.keys(mes)])].sort();
  for (const machine of machines) {
    const t = truth[machine] ?? {};
    const m = mes[machine] ?? {};
    const states = [...new Set([...MACHINE_STATES, ...Object.keys(t), ...Object.keys(m)])];
    for (const state of states) {
      const a = t[state] ?? 0;
      const b = m[state] ?? 0;
      if (a !== b) result.push({ machine, state, truth: a, mes: b });
    }
  }
  return result;
}

/** A readable table of the differences, with the delta (MES − truth) in ms. */
export function formatDifferences(diffs: readonly Difference[]): string {
  const header = ['machine', 'state', 'truth ms', 'MES ms', 'MES − truth'];
  const rows = diffs.map((d) => [
    d.machine,
    d.state,
    String(d.truth),
    String(d.mes),
    String(d.mes - d.truth),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** A stored piece of `equipment.equipment_state_interval`, times in ms. */
export interface Piece {
  readonly equipment: string;
  readonly start: number;
  readonly end: number;
  readonly hour: number;
  readonly shiftKey: string;
}

/**
 * Pieces that are empty, cross a UTC hour, carry the wrong hour, or don't lie inside exactly one
 * shift bucket with their own key. `segments` returns the shared calendar's buckets of a range.
 */
export function pieceViolations(
  pieces: readonly Piece[],
  segments: (from: number, to: number) => readonly ShiftSegment[],
): string[] {
  const problems: string[] = [];
  for (const piece of pieces) {
    const name = `${piece.equipment} [${new Date(piece.start).toISOString()}, ${new Date(piece.end).toISOString()}) ${piece.shiftKey}`;
    if (piece.end <= piece.start) {
      problems.push(`${name}: empty`);
      continue;
    }
    const hour = Math.floor(piece.start / HOUR) * HOUR;
    if (piece.hour !== hour) problems.push(`${name}: hour ${new Date(piece.hour).toISOString()}`);
    if (piece.end > hour + HOUR) problems.push(`${name}: crosses the UTC hour`);
    const buckets = segments(piece.start, piece.end);
    if (buckets.length !== 1 || buckets[0]?.key !== piece.shiftKey) {
      problems.push(`${name}: shift buckets ${buckets.map((b) => b.key).join(', ')}`);
    }
  }
  return problems;
}

/** Nearest-rank percentile of a non-empty list. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}
