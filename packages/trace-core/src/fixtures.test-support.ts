/** Test fixtures: units through OP10–OP50 with lots, operators and leak readings. */
import { DEFAULT_RULES } from '@shopfloor/spc-core';
import type { TraceConfig, TraceRecord, UnitInput } from './trace.ts';

export const CONFIG: TraceConfig = {
  packOperation: 'OP50',
  capacity: { 'VB-100': 3, 'VB-200': 2 },
  spc: {
    characteristic: 'leak-rate',
    operation: 'OP40',
    subgroupSize: 2,
    baselineSubgroups: 2,
    rules: DEFAULT_RULES,
  },
};

const MINUTE = 60_000;

export interface UnitPlan {
  readonly partId: number;
  readonly epoch?: number;
  readonly orderId?: string | null;
  readonly product?: string;
  /** Start of OP10, in minutes. */
  readonly start: number;
  readonly blank?: string;
  readonly kit?: string;
  readonly reading?: number;
  /** A leak failure: rework at OP30 with this kit lot, then a retest with `retest`. */
  readonly rework?: { readonly kit: string; readonly retest: number };
  /** Scrapped at OP40 (no pack). */
  readonly scrap?: boolean;
  /** Stops after this many operations (WIP). */
  readonly upTo?: number;
}

/** A unit whose operations complete one minute apart from `start`. */
export function unit(plan: UnitPlan): UnitInput {
  const product = plan.product ?? 'VB-100';
  let minute = plan.start;
  let seq = plan.partId * 100;
  const record = (
    operation: string,
    machine: string,
    extra: Partial<TraceRecord> = {},
  ): TraceRecord => ({
    operation,
    pass: 1,
    machine,
    at: (minute += 1) * MINUTE,
    seq: (seq += 1),
    result: 'good',
    reason: null,
    lots: [],
    operator: null,
    reading: null,
    ...extra,
  });
  const records: TraceRecord[] = [
    record('OP10', 'cnc-01', { lots: [{ material: 'BLANK-100', lot: plan.blank ?? 'BL-1' }] }),
    record('OP20', 'wsh-01'),
    record('OP30', 'asm-01', {
      lots: [{ material: 'SK-1', lot: plan.kit ?? 'SK-1A' }],
      operator: 'OP-A',
    }),
  ];
  if (plan.rework) {
    records.push(
      record('OP40', 'lkt-01', { reading: plan.reading ?? 3300, result: 'rework' }),
      record('OP30', 'asm-01', {
        pass: 2,
        lots: [{ material: 'SK-1', lot: plan.rework.kit }],
        operator: 'OP-B',
      }),
      record('OP40', 'lkt-01', { pass: 2, reading: plan.rework.retest }),
    );
  } else {
    records.push(
      record('OP40', 'lkt-01', {
        reading: plan.reading ?? 2000,
        result: plan.scrap ? 'scrap' : 'good',
        reason: plan.scrap ? 'LEAK' : null,
      }),
    );
  }
  if (!plan.scrap) records.push(record('OP50', 'pck-01'));
  return {
    epoch: plan.epoch ?? 1,
    partId: plan.partId,
    serial: `${product}-${String(plan.partId).padStart(6, '0')}`,
    product,
    orderId: plan.orderId === undefined ? 'ORD-1' : plan.orderId,
    records: records.slice(0, plan.upTo ?? records.length),
  };
}

export const at = (minutes: number): number => minutes * MINUTE;
