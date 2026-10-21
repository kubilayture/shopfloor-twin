import type { SpcChartName } from '@shopfloor/contracts/mes-api';
import { fraction, multiply, toDecimal, type Fraction } from '@shopfloor/oee-core';

/**
 * Measured values and SPC statistics as text (#295). The API's doubles are for display only
 * (`3381 × 0.001` is `3.3810000000000002` in binary), so the web never prints one as it is. The
 * rule, recorded in the Phase 10 log:
 *
 * - A characteristic's readings, and ranges of them (I, MR and R points, retests), are shown with
 *   the decimals of its `resolution` (the instrument's step, `0.001` → 3): `3.381`.
 * - Anything averaged or estimated (X̄ points, centre lines, control limits, σ̂) gets one decimal
 *   more than the readings: `3.3813`.
 * - Cpk keeps two decimals.
 * - Where the payload names no resolution (a trace reading, a telemetry value), at most
 *   `MAX_DECIMALS` decimals with trailing zeros dropped: it strips the binary noise and never hides
 *   an instrument step coarser than 10⁻⁶.
 *
 * Rounding is half away from zero on the exact decimal value (`oee-core`'s `toDecimal`), never
 * `Number.toFixed`'s binary rounding (`1.005.toFixed(2)` is `1.00`). An SPC value with its exact
 * `steps` is rounded from the steps; anything else from the double's 15-significant-digit form.
 */

export const MAX_DECIMALS = 6;

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/** A finite double as the exact fraction of its decimal form at 15 significant digits. */
export function decimalFraction(value: number): Fraction {
  const match = Number.isFinite(value) ? DECIMAL.exec(value.toPrecision(15)) : null;
  if (!match) throw new RangeError(`not a finite number: ${String(value)}`);
  const [, sign = '', whole = '', decimals = '', exponent = '0'] = match;
  const digits = BigInt(`${sign}${whole}${decimals}`);
  const scale = decimals.length - Number(exponent);
  return scale >= 0
    ? fraction(digits, 10n ** BigInt(scale))
    : fraction(digits * 10n ** BigInt(-scale));
}

/**
 * The decimals a step needs to be written exactly: `0.001` → 3, `0.1` → 1, `0.25` → 2, `1` → 0;
 * `MAX_DECIMALS` when it has more, or is no positive number.
 */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return MAX_DECIMALS;
  const { den } = decimalFraction(step);
  for (let places = 0; places < MAX_DECIMALS; places += 1) {
    if (10n ** BigInt(places) % den === 0n) return places;
  }
  return MAX_DECIMALS;
}

/** A double with exactly `places` decimals, rounded half away from zero on its decimal value. */
export function fixedText(value: number, places: number): string {
  return toDecimal(decimalFraction(value), places);
}

/** A double whose precision nobody named: at most `MAX_DECIMALS` decimals, no trailing zeros. */
export function plainText(value: number): string {
  return fixedText(value, MAX_DECIMALS).replace(/\.?0+$/, '');
}

/** How a characteristic's values are written: decimals of readings and of statistics. */
export interface SpcPrecision {
  /** Readings and ranges of readings: the resolution's decimals. */
  readonly reading: number;
  /** Means, centre lines, limits and σ̂: one decimal more. */
  readonly statistic: number;
  /** One resolution step, exactly. */
  readonly step: Fraction;
}

export function spcPrecision(resolution: number): SpcPrecision {
  const reading = decimalsOf(resolution);
  const step =
    Number.isFinite(resolution) && resolution > 0 ? decimalFraction(resolution) : fraction(0n);
  return { reading, statistic: reading + 1, step };
}

/** The decimals a chart's points are shown with: X̄ is a mean, the others readings or ranges. */
export const pointDecimals = (precision: SpcPrecision, chart: SpcChartName): number =>
  chart === 'Xbar' ? precision.statistic : precision.reading;

const STEPS = /^(-?\d+)\/(\d+)$/;

/**
 * An SPC value (`value`, and `steps`: the exact value in resolution steps) with `places` decimals,
 * rounded from its exact steps; from the double when the steps can't be read.
 */
export function spcValueText(
  v: { readonly value: number; readonly steps: string | number },
  precision: SpcPrecision,
  places: number,
): string {
  const match = typeof v.steps === 'number' ? null : STEPS.exec(v.steps);
  const steps =
    typeof v.steps === 'number'
      ? Number.isSafeInteger(v.steps)
        ? fraction(BigInt(v.steps))
        : undefined
      : match && match[2] !== '0'
        ? fraction(BigInt(match[1] ?? '0'), BigInt(match[2] ?? '1'))
        : undefined;
  if (steps === undefined || precision.step.num === 0n) return fixedText(v.value, places);
  return toDecimal(multiply(steps, precision.step), places);
}
