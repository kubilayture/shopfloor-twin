import type {
  BottleneckDto,
  LineBucketDto,
  OeeBucketDto,
  OeeResultDto,
  OrderOeeDto,
  Ratio,
} from '@shopfloor/contracts/mes-api';
import { fraction, multiply, toDecimal, type Fraction } from '@shopfloor/oee-core';

/**
 * OEE values are shown as the MES sends them (ADR-0021): exact fractions and four-decimal strings,
 * never recomputed in floating point here. Anything derived is exact BigInt arithmetic
 * (`@shopfloor/oee-core`'s fractions) or string manipulation.
 */

export const NOT_APPLICABLE = 'n/a';

/** A ratio's four-decimal string, or `n/a` when the MES says it is not applicable (null). */
export function ratioText(ratio: Ratio | null | undefined): string {
  return ratio ? ratio.decimal : NOT_APPLICABLE;
}

/**
 * A four-decimal string as a percentage with two decimals, by moving the decimal point:
 * `0.8193` → `81.93 %`, `1.0421` → `104.21 %`. Null is `n/a`, never 0.
 */
export function percentText(ratio: Ratio | null | undefined): string {
  if (!ratio) return NOT_APPLICABLE;
  const match = /^(-?)(\d+)\.(\d{4})$/.exec(ratio.decimal);
  if (!match) return ratio.decimal;
  const [, sign = '', whole = '', decimals = ''] = match;
  const integer = `${whole}${decimals.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  return `${sign}${integer}.${decimals.slice(2)} %`;
}

/** `"num/den"` from the API as an exact fraction. */
export function parseFraction(text: string): Fraction {
  const match = /^(-?\d+)\/(\d+)$/.exec(text);
  if (!match) throw new RangeError(`not a fraction: ${text}`);
  return fraction(BigInt(match[1] ?? '0'), BigInt(match[2] ?? '1'));
}

const subtract = (a: Fraction, b: Fraction): Fraction =>
  fraction(a.num * b.den - b.num * a.den, a.den * b.den);

const MINUTE = fraction(1n, 60_000n);

/** Milliseconds (exact) as minutes with one decimal, rounded half-up: `123.5 min`. */
export function minutesText(ms: Fraction | number): string {
  const value = typeof ms === 'number' ? fraction(BigInt(ms)) : ms;
  return `${toDecimal(multiply(value, MINUTE), 1)} min`;
}

const SECOND = fraction(1n, 1_000n);

/** Exact ms as seconds with three decimals (exact for whole ms, rounded half-up otherwise). */
export function secondsText(ms: Fraction): string {
  return `${toDecimal(multiply(ms, SECOND), 3)} s`;
}

export type WaterfallKind = 'total' | 'loss' | 'gain';

export interface WaterfallStep {
  readonly key: string;
  readonly label: string;
  readonly kind: WaterfallKind;
  /** Exact ms the bar stands for: a total's level, or a step's size (always ≥ 0). */
  readonly ms: Fraction;
  /** For drawing only: where the bar starts and ends, in ms. */
  readonly from: number;
  readonly to: number;
}

/** `−` for a loss, `+` for a gain, nothing for a total or a step of exactly 0. */
export function stepSign(step: WaterfallStep): string {
  if (step.kind === 'total' || step.ms.num === 0n) return '';
  return step.kind === 'loss' ? '−' : '+';
}

export interface Waterfall {
  readonly steps: readonly WaterfallStep[];
  /** PBT − own − external = APT, APT − micro-stops − speed = ideal and ideal − quality = OEE × PBT. */
  readonly consistent: boolean;
}

const toNumber = (f: Fraction): number => Number(f.num) / Number(f.den);

/**
 * The loss waterfall of one bucket from the MES's own totals and losses (plan "API, push and
 * web"): PBT → own → external → APT → micro-stops → speed → quality → fully productive. Every
 * step is an API value; only "fully productive" is derived, as ideal ms − the quality loss, in
 * exact fractions, so the bars add up exactly. Null when PBT = 0 (no losses: OEE is n/a).
 */
export function waterfall(result: OeeResultDto): Waterfall | null {
  const { losses, totals } = result;
  if (!losses) return null;
  const pbt = fraction(BigInt(totals.plannedBusyMs));
  const own = fraction(BigInt(losses.availability.own.total));
  const external = fraction(BigInt(losses.availability.external.total));
  const apt = fraction(BigInt(totals.actualProductionMs));
  const micro = fraction(BigInt(losses.performance.microStops));
  const speed = fraction(BigInt(losses.performance.speed));
  const ideal = fraction(BigInt(totals.idealMs));
  const quality = parseFraction(losses.quality.fraction);
  const productive = subtract(ideal, quality);

  const zero = fraction(0n);
  const same = (a: Fraction, b: Fraction) => a.num === b.num && a.den === b.den;
  const oee = result.oee ? parseFraction(result.oee.fraction) : undefined;
  const consistent =
    same(subtract(subtract(pbt, own), external), apt) &&
    same(subtract(subtract(apt, micro), speed), ideal) &&
    (oee === undefined || same(multiply(oee, pbt), productive));

  const steps: WaterfallStep[] = [];
  let level = zero;
  const total = (key: string, label: string, value: Fraction) => {
    steps.push({ key, label, kind: 'total', ms: value, from: 0, to: toNumber(value) });
    level = value;
  };
  const drop = (key: string, label: string, size: Fraction) => {
    const next = subtract(level, size);
    const gain = size.num < 0n;
    steps.push({
      key,
      label,
      kind: gain ? 'gain' : 'loss',
      ms: gain ? fraction(-size.num, size.den) : size,
      from: toNumber(gain ? level : next),
      to: toNumber(gain ? next : level),
    });
    level = next;
  };
  total('pbt', 'Planned busy time', pbt);
  drop('own', 'Availability loss, own', own);
  drop('external', 'Availability loss, external', external);
  total('apt', 'Actual production time', apt);
  drop('micro', 'Micro-stops', micro);
  drop('speed', 'Speed loss', speed);
  drop('quality', 'Quality loss', quality);
  total('productive', 'Fully productive time', productive);
  return { steps, consistent };
}

export interface BucketFlag {
  readonly key: 'final' | 'provisional' | 'revision' | 'incidents' | 'anomaly';
  readonly text: string;
  readonly title: string;
}

/** What may still change about a bucket, as text (never colour alone). */
export function bucketFlags(bucket: OeeBucketDto): BucketFlag[] {
  const flags: BucketFlag[] = [];
  if (bucket.final) {
    flags.push({ key: 'final', text: 'Final', title: 'Nothing that can still arrive changes it' });
  } else {
    flags.push({
      key: 'provisional',
      text: `Provisional (${minutesText(bucket.provisionalMs)})`,
      title: 'Time in pieces that may still change',
    });
  }
  if (bucket.revision > 0) {
    flags.push({
      key: 'revision',
      text: `Revision ${String(bucket.revision)}`,
      title: 'Changed after it was final (late data)',
    });
  }
  if (bucket.incidents > 0) {
    flags.push({
      key: 'incidents',
      text: `${String(bucket.incidents)} incident${bucket.incidents === 1 ? '' : 's'}`,
      title: 'Sequence gaps reported over its hours',
    });
  }
  if (bucket.result.anomaly) {
    flags.push({
      key: 'anomaly',
      text: 'Anomaly',
      title: 'Cycles were counted although there was no production time',
    });
  }
  return flags;
}

/**
 * The bucket to show for one key. The MES pushes the whole bucket after any change (at most a
 * second apart) while the plant clock is in it, so a pushed bucket replaces the REST one, unless
 * the REST answer is further along: final where the push is not (the bucket became final after
 * the clock left it), or a higher revision. Alarm KPI buckets (#145) follow the same rule.
 */
export function pickBucket<B extends { readonly final: boolean; readonly revision: number }>(
  rest: B | undefined,
  pushed: B | undefined,
): B | undefined {
  if (!pushed) return rest;
  if (!rest) return pushed;
  if (rest.final && !pushed.final) return rest;
  if (rest.revision > pushed.revision) return rest;
  return pushed;
}

// ---- Order and line OEE (#233, ADR-0036) ----

/**
 * The machines the MES names as a bottleneck (`bottlenecks` of `GET /oee/line` and `oee:line`),
 * each with the products it is the bottleneck of, in the MES's order. The web never decides the
 * bottleneck itself: `oee-core` derives it from the routing (ideal cycle ÷ machines on the
 * operation, the largest; ADR-0036).
 */
export function bottleneckMachines(
  bottlenecks: readonly BottleneckDto[],
): ReadonlyMap<string, readonly string[]> {
  const machines = new Map<string, string[]>();
  for (const { product, equipment } of bottlenecks) {
    for (const id of equipment) {
      const products = machines.get(id) ?? [];
      if (!products.includes(product)) products.push(product);
      machines.set(id, products);
    }
  }
  return machines;
}

/** `150000/1` ms of line time per unit as seconds: `150.000 s`. */
export function cycleText(effectiveCycleMs: string): string {
  return secondsText(parseFraction(effectiveCycleMs));
}

/** Units packed good per product, in product order: `VB-100 12 · VB-200 3`, or `none`. */
export function goodText(good: Readonly<Record<string, number>>): string {
  const entries = Object.entries(good)
    .filter(([, n]) => n !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0
    ? 'none'
    : entries.map(([product, n]) => `${product} ${String(n)}`).join(' · ');
}

export interface StatusFlag {
  readonly key: string;
  readonly text: string;
  readonly title: string;
  /** `final` reads as settled; `notice` as something that may still change or needs a word. */
  readonly tone: 'final' | 'notice';
}

/** Why a line value can exceed 1 (ADR-0036): shown with the flag, never capped. */
export const ABOVE_ONE_TEXT =
  'More was packed than the bottleneck’s ideal rate allows for this time: an operator faster than ideal, or WIP drained from the buffers. Reported as computed, not capped, so the hours and the shift agree.';

const ABOVE_ONE: StatusFlag = {
  key: 'above-one',
  text: 'Above 1',
  title: ABOVE_ONE_TEXT,
  tone: 'notice',
};

function revisionFlags(value: {
  readonly revision: number;
  readonly incidents: readonly unknown[];
  readonly mayRevise: boolean;
}): StatusFlag[] {
  const flags: StatusFlag[] = [];
  if (value.revision > 0) {
    flags.push({
      key: 'revision',
      text: `Revision ${String(value.revision)}`,
      title: 'Changed after it was final (late data under a written-off gap)',
      tone: 'notice',
    });
  }
  const n = value.incidents.length;
  if (n > 0) {
    flags.push({
      key: 'incidents',
      text: `${String(n)} incident${n === 1 ? '' : 's'}`,
      title: 'Sequence gaps written off under it (ADR-0018)',
      tone: 'notice',
    });
  }
  if (value.mayRevise) {
    flags.push({
      key: 'may-revise',
      text: 'May be revised',
      title: 'It lies over a written-off gap: even a final value may still change',
      tone: 'notice',
    });
  }
  return flags;
}

/** What may still change about a line OEE bucket, as text (never colour alone). */
export function lineFlags(bucket: LineBucketDto): StatusFlag[] {
  const flags: StatusFlag[] = [
    bucket.final
      ? {
          key: 'final',
          text: 'Final',
          title: 'Nothing that can still arrive changes it',
          tone: 'final',
        }
      : {
          key: 'provisional',
          text: 'Provisional',
          title: 'An input is not final through the bucket’s end yet',
          tone: 'notice',
        },
    ...revisionFlags(bucket),
  ];
  if (bucket.aboveOne) flags.push(ABOVE_ONE);
  return flags;
}

/** Why an order's OEE is not final yet, as short phrases (empty when it is). */
export function orderPending(order: OrderOeeDto): string[] {
  if (order.final) return [];
  const reasons: string[] = [];
  if (order.lost) reasons.push('a fact a job window needs is lost: never final');
  if (order.open) reasons.push('a job window is still open');
  if (order.pending) reasons.push('a job has no window yet');
  if (order.headTimeUnknown) reasons.push('a head time is unknown, its changeover left out');
  if (order.endLost) reasons.push('a job’s completion is lost');
  if (reasons.length === 0) reasons.push('its inputs are not final yet');
  return reasons;
}

/** What may still change about an order's OEE (and its jobs), as text. */
export function orderFlags(order: OrderOeeDto): StatusFlag[] {
  return [
    order.final
      ? {
          key: 'final',
          text: 'Final',
          title: 'Every job window closed and its inputs final',
          tone: 'final',
        }
      : {
          key: 'provisional',
          text: order.lost ? 'Never final' : 'Provisional',
          title: orderPending(order).join('; '),
          tone: 'notice',
        },
    ...revisionFlags(order),
  ];
}

/** The status of an order's own line OEE (`line` of `GET /oee/orders/{id}`). */
export function orderLineFlags(line: NonNullable<OrderOeeDto['line']>): StatusFlag[] {
  const flags: StatusFlag[] = [
    line.final
      ? {
          key: 'final',
          text: 'Final',
          title: 'The order is complete and the bottleneck’s pieces final',
          tone: 'final',
        }
      : {
          key: 'provisional',
          text: line.open ? 'Provisional (order in progress)' : 'Provisional',
          title: line.open
            ? 'The order is not complete: its in-progress time runs to the plant clock'
            : 'An input is not final yet',
          tone: 'notice',
        },
  ];
  if (line.aboveOne) flags.push(ABOVE_ONE);
  return flags;
}

/**
 * The order OEE to show, part by part (#233 review): the pushed body (`oee:order:<id>`) over the
 * REST one, except where the REST answer is further along. The order OEE with its jobs, the
 * first-pass yield and the order's line OEE each turn final on their own, so each part is taken
 * from the REST answer when it is final there and not in the push (or the REST answer has a
 * higher revision), as `pickBucket` does for a bucket. A final part never changes again (or only
 * with a higher revision), so mixing parts of two answers shows nothing that was never true.
 */
export function pickOrderOee(
  rest: OrderOeeDto | undefined,
  pushed: OrderOeeDto | null | undefined,
): OrderOeeDto | undefined {
  if (!pushed) return rest;
  if (!rest) return pushed;
  const restAhead = rest.revision > pushed.revision;
  const order = restAhead || (rest.final && !pushed.final);
  // A part final on one side only comes from that side; otherwise from where the order part does.
  const fromRest = <T>(r: T, p: T, final: (value: T) => boolean): boolean =>
    restAhead || (final(r) !== final(p) ? final(r) : order);
  const yieldPart = fromRest(rest.firstPassYield, pushed.firstPassYield, (f) => f.final);
  const line = fromRest(rest.line, pushed.line, (l) => l?.final === true);
  if (order === yieldPart && order === line) return order ? rest : pushed;
  return {
    ...(order ? rest : pushed),
    firstPassYield: yieldPart ? rest.firstPassYield : pushed.firstPassYield,
    line: line ? rest.line : pushed.line,
  };
}
