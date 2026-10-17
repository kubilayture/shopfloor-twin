/**
 * Control chart constants (ADR-0032), as exact fractions of the textbook's three-decimal values
 * (ASTM E2587, Montgomery appendix VI). `docs/spc-reference-cases.md` lists the same table and its
 * test compares them cell by cell.
 */
import type { Fraction } from '@shopfloor/oee-core';
import { decimal } from './rational.ts';

export interface SubgroupConstants {
  /** X̄ chart limits: X̿ ± A2·R̄. */
  readonly a2: Fraction;
  /** R chart lower limit: D3·R̄. */
  readonly d3: Fraction;
  /** R chart upper limit: D4·R̄. */
  readonly d4: Fraction;
  /** σ̂ = R̄ / d2. */
  readonly d2: Fraction;
}

const TABLE: Readonly<Record<number, readonly [string, string, string, string]>> = {
  2: ['1.880', '0', '3.267', '1.128'],
  3: ['1.023', '0', '2.574', '1.693'],
  4: ['0.729', '0', '2.282', '2.059'],
  5: ['0.577', '0', '2.114', '2.326'],
  6: ['0.483', '0', '2.004', '2.534'],
  7: ['0.419', '0.076', '1.924', '2.704'],
  8: ['0.373', '0.136', '1.864', '2.847'],
  9: ['0.337', '0.184', '1.816', '2.970'],
  10: ['0.308', '0.223', '1.777', '3.078'],
};

/** Subgroup sizes with constants: 2 to 10. */
export const SUBGROUP_SIZES: readonly number[] = Object.keys(TABLE).map(Number);

/** The constants for subgroups of `size`; throws outside 2–10. */
export function subgroupConstants(size: number): SubgroupConstants {
  const row = TABLE[size];
  if (row === undefined) {
    throw new RangeError(`no control chart constants for subgroups of ${String(size)} (2–10)`);
  }
  const [a2, d3, d4, d2] = row;
  return { a2: decimal(a2), d3: decimal(d3), d4: decimal(d4), d2: decimal(d2) };
}

/** I chart limits: X̄ ± E2·M̄R, with E2 = 3 / d2(2) rounded as the plan writes it, 2.66. */
export const E2: Fraction = decimal('2.66');

/** MR chart upper limit: D4(2)·M̄R; its lower limit is D3(2)·M̄R = 0. */
export const MR_D4: Fraction = decimal('3.267');
