import type { OeeBucketDto, OeeResultDto, Ratio } from '@shopfloor/contracts/mes-api';
import { fraction, multiply, toDecimal, type Fraction } from '@shopfloor/oee-core';

/**
 * OEE values are shown as the MES sends them (ADR-0021): exact fractions and four-decimal strings,
 * never recomputed in floating point here. Anything derived is exact BigInt arithmetic
 * (`@shopfloor/oee-core`'s fractions) or string manipulation.
 */

/** The designed bottleneck (plan section 5: OP30 assembly, 150 s against OP10's 120 s). */
export const DESIGNED_BOTTLENECK = 'asm-01';

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
 * the clock left it), or a higher revision.
 */
export function pickBucket(
  rest: OeeBucketDto | undefined,
  pushed: OeeBucketDto | undefined,
): OeeBucketDto | undefined {
  if (!pushed) return rest;
  if (!rest) return pushed;
  if (rest.final && !pushed.final) return rest;
  if (rest.revision > pushed.revision) return rest;
  return pushed;
}
