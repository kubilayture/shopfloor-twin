/**
 * Line throughput OEE's inputs (#232, P9-05; ADR-0036 and its amendments), pure so the conventions
 * are tested on their own and shared by the line buckets (`line-oee.ts`) and the per-order value
 * (`order-oee.ts`). They are the simulator truth's (`apps/simulator/src/headless/line-oee-truth.ts`)
 * exactly:
 *
 * - **Bottleneck:** `deriveBottlenecks` from the routing and the equipment (the designed one,
 *   ASM-01 for both products); its effective cycle per product prices one good unit.
 * - **Good packed:** `good` cycles at the last operation's machines (PCK-01), bucketed by their
 *   time; per order its own units' good records at the last operation.
 * - **Planned busy time** (`linePlannedBusyMs`): the bucket's scheduled time (the shift buckets, no
 *   `no-shift`), minus the calendar's breaks and the Maintenance intervals of the bottleneck's
 *   machines; in orders mode only where an order is in progress (from the earliest head time of its
 *   jobs to its ADR-0031 completion, or the cut-off while open).
 * - **Ratio:** `lineOee`: not capped (`aboveOne`), null when the planned busy time is 0.
 * - **Cut-off:** exclusive; a bucket reaching past it counts planned time and packs only before it.
 */
import {
  deriveBottlenecks,
  lineOee,
  linePlannedBusyMs,
  normalize,
  type Bottleneck,
  type Fraction,
  type LineOeeResult,
  type Millis,
  type Range,
} from '@shopfloor/oee-core';
import {
  HOUR,
  NO_SHIFT,
  shiftBoundaries,
  shiftSegments,
  type ShiftPattern,
} from '@shopfloor/shift-calendar';

const DAY = 24 * HOUR;

/** The machines and the bottleneck line OEE reads, from master data and the routing. */
export interface LineModel {
  readonly bottlenecks: Readonly<Record<string, Bottleneck>>;
  readonly effectiveCycleMs: Readonly<Record<string, Fraction>>;
  /** The bottleneck operations' machines (their Maintenance is a planned stop), sorted. */
  readonly bottleneckMachines: readonly string[];
  /** The last operation's machines (good packed), sorted. */
  readonly packing: readonly string[];
  /** The first operation's machines (the CNCs, whose job facts give head times), sorted. */
  readonly first: readonly string[];
  /** Every machine of the routing, sorted. */
  readonly machines: readonly string[];
}

export function lineModel(
  equipment: readonly { readonly id: string; readonly operation: string }[],
  operations: readonly string[],
  idealCycleMs: Readonly<Record<string, Readonly<Record<string, Millis>>>>,
): LineModel {
  const bottlenecks = deriveBottlenecks({ operations, equipment, idealCycleMs });
  const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();
  const firstOp = operations[0];
  const lastOp = operations.at(-1);
  return {
    bottlenecks,
    effectiveCycleMs: Object.fromEntries(
      Object.entries(bottlenecks).map(([product, b]) => [product, b.effectiveCycleMs]),
    ),
    bottleneckMachines: sorted(Object.values(bottlenecks).flatMap((b) => b.equipment)),
    packing: sorted(equipment.filter((e) => e.operation === lastOp).map((e) => e.id)),
    first: sorted(equipment.filter((e) => e.operation === firstOp).map((e) => e.id)),
    machines: sorted(equipment.filter((e) => operations.includes(e.operation)).map((e) => e.id)),
  };
}

/**
 * The calendar over `span`: the scheduled time (shift buckets, no `no-shift`) and the breaks, each
 * clipped to the span, as the truth cuts them to its run.
 */
export function calendar(
  pattern: ShiftPattern,
  span: Range,
): { scheduled: Range[]; breaks: Range[] } {
  const scheduled = normalize(
    shiftSegments(pattern, span.from, span.to)
      .filter((segment) => segment.key !== NO_SHIFT)
      .map(({ from, to }) => ({ from, to })),
  );
  const breaks: Range[] = [];
  const starts = new Map<string, Millis>();
  for (const boundary of shiftBoundaries(pattern, span.from - DAY, span.to + DAY)) {
    const key = `${boundary.shiftDate}/${boundary.shiftId}`;
    if (boundary.action === 'break-start') starts.set(key, boundary.at);
    if (boundary.action !== 'break-end') continue;
    const from = Math.max(starts.get(key) ?? boundary.at, span.from);
    const to = Math.min(boundary.at, span.to);
    if (to > from) breaks.push({ from, to });
  }
  return { scheduled, breaks };
}

/** The Maintenance time of the bottleneck machines' stored pieces (planned stops). */
export function maintenance(
  pieces: readonly { readonly start: Date; readonly end: Date; readonly state: string }[],
): Range[] {
  return normalize(
    pieces
      .filter((piece) => piece.state === 'Maintenance')
      .map((piece) => ({ from: piece.start.getTime(), to: piece.end.getTime() })),
  );
}

/** One packed good unit: its time and product. */
export interface Pack {
  readonly at: Millis;
  readonly product: string;
}

/** Line OEE of one bucket or order (`lineOee` with its inputs). */
export interface LineValue {
  readonly from: Millis;
  readonly to: Millis;
  /** Planned time and packs are counted before this instant (the cut-off, or `to`). */
  readonly through: Millis;
  readonly plannedBusyMs: number;
  /** Units packed good, per product (products with none left out), sorted. */
  readonly good: Readonly<Record<string, number>>;
  readonly result: LineOeeResult;
}

export interface LineValueInput {
  readonly bucket: Range;
  /** The cut-off (exclusive): planned time and packs after it are not counted yet. */
  readonly cut: Millis;
  readonly scheduled: readonly Range[];
  readonly plannedStops: readonly Range[];
  /** Orders mode: the orders' in-progress ranges; undefined in schedule mode. */
  readonly inProgress?: readonly Range[] | undefined;
  /** Packs in any order; only those inside the counted part of the bucket count (see below). */
  readonly packs: readonly Pack[];
  /**
   * `false` for an order's value: every one of its packs counts, also the one at its completion
   * (the range's exclusive end), as the truth counts an order's packs. Default `true`.
   */
  readonly packsInRange?: boolean;
  readonly effectiveCycleMs: Readonly<Record<string, Fraction>>;
}

export function lineValue(input: LineValueInput): LineValue {
  const { bucket } = input;
  const through = Math.min(bucket.to, Math.max(bucket.from, input.cut));
  const counted = { from: bucket.from, to: through };
  const plannedBusyMs = linePlannedBusyMs({
    bucket: counted,
    scheduled: input.scheduled,
    plannedStops: input.plannedStops,
    ...(input.inProgress === undefined ? {} : { inProgress: input.inProgress }),
  });
  const good = new Map<string, number>();
  for (const pack of input.packs) {
    if (input.packsInRange !== false && (pack.at < counted.from || pack.at >= counted.to)) {
      continue;
    }
    good.set(pack.product, (good.get(pack.product) ?? 0) + 1);
  }
  const sorted = [...good].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const result = lineOee({
    plannedBusyMs,
    good: sorted.map(([product, count]) => ({ product, count })),
    effectiveCycleMs: input.effectiveCycleMs,
  });
  return {
    from: bucket.from,
    to: bucket.to,
    through,
    plannedBusyMs,
    good: Object.fromEntries(sorted),
    result,
  };
}

/**
 * Whether a gap incident (its neighbours' times, open ends unbounded) touches [from, to]: an
 * incident ending exactly at `from` or starting exactly at `to` counts (its lost facts may lie on
 * that instant).
 */
export function gapTouches(
  gap: { readonly after: Date | null; readonly before: Date | null },
  from: Millis,
  to: Millis,
): boolean {
  const after = gap.after?.getTime() ?? Number.NEGATIVE_INFINITY;
  const before = gap.before?.getTime() ?? Number.POSITIVE_INFINITY;
  return after <= to && before >= from;
}
