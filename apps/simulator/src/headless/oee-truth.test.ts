import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  bucketOee,
  bucketTotals,
  oeeFromTotals,
  sumTotals,
  type BucketInput,
  type OeeTotals,
} from '@shopfloor/oee-core';
import { idealCycleMs, type PlantConfig } from '@shopfloor/plant-config';
import { shiftKeyAt } from '@shopfloor/shift-calendar';
import { RandomSource } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProductionLine, type PlantEvent } from '../plant/line.ts';
import type { MachineState } from '../plant/machine-state.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { resultJson, type BucketInputsJson, type OeeSummary } from './oee-truth.ts';
import { GroundTruth, type GroundTruthSummary } from './summary.ts';

let config: PlantConfig;

beforeAll(async () => {
  config = await loadDefaultConfig();
});

const MIN = 60_000;
// Monday 2026-10-12 13:00 Istanbul (10:00 UTC): the last hour of shift A; B starts at 11:00 UTC.
const S = Date.UTC(2026, 9, 12, 10);
const B = S + 60 * MIN;

const state = (at: number, from: MachineState, to: MachineState): PlantEvent => ({
  type: 'state',
  machineId: 'cnc-01',
  at,
  from,
  to,
});
const cycle = (at: number, result: 'good' | 'scrap'): PlantEvent => ({
  type: 'cycle-complete',
  at,
  machineId: 'cnc-01',
  product: 'VB-100',
  partId: 1,
  serial: '',
  result,
});
const shift = (at: number, shiftId: string): PlantEvent => ({
  type: 'shift',
  at,
  action: 'shift-start',
  shiftId,
  shiftDate: '2026-10-12',
});

/**
 * A constructed hour and a bit of CNC-01 (ideal 240 s for VB-100 at OP10; threshold 120 s):
 * stops of 60 s (micro), 180 s (long) and 90 s across 11:00 UTC (micro, 60 s in A and 30 s in B),
 * a good and a scrap cycle in A, a good cycle exactly at 11:00 recorded before B's shift event,
 * and a stop opened at 11:05.
 */
const EVENTS: readonly PlantEvent[] = [
  shift(S, 'A'),
  state(S, 'Off', 'Running'),
  state(S + 10 * MIN, 'Running', 'Stopped'),
  state(S + 11 * MIN, 'Stopped', 'Running'),
  cycle(S + 20 * MIN, 'good'),
  cycle(S + 30 * MIN, 'scrap'),
  state(S + 40 * MIN, 'Running', 'Stopped'),
  state(S + 43 * MIN, 'Stopped', 'Running'),
  state(S + 59 * MIN, 'Running', 'Stopped'),
  cycle(B, 'good'),
  shift(B, 'B'),
  state(B + 30_000, 'Stopped', 'Running'),
  state(B + 5 * MIN, 'Running', 'Stopped'),
];

function constructed(snapshotsAt: readonly number[] = []): {
  truth: GroundTruth;
  read: (now: number) => GroundTruthSummary;
} {
  const truth = new GroundTruth(config, S);
  const line = new ProductionLine({ config, random: new RandomSource(1), startTime: S });
  const read = (now: number) => truth.snapshot(now, line, []);
  const pending = [...snapshotsAt];
  for (const event of EVENTS) {
    while (pending[0] !== undefined && pending[0] <= event.at) {
      read(pending.shift() ?? 0);
    }
    truth.record(event);
  }
  return { truth, read };
}

const states = (partial: Partial<Record<MachineState, number>>) => ({
  Off: 0,
  Idle: 0,
  Running: 0,
  Stopped: 0,
  Starved: 0,
  Blocked: 0,
  Setup: 0,
  Down: 0,
  PlannedStop: 0,
  Maintenance: 0,
  ...partial,
});

describe('ground-truth OEE, by hand (#117)', () => {
  it('equals a hand calculation for a closed shift bucket', () => {
    const oee = constructed().read(B + 6 * MIN).oee;
    const a = oee.machines['cnc-01']?.shifts['2026-10-12/A'];
    expect(a?.inputs).toEqual({
      scheduled: true,
      // 3 600 s − 60 − 180 − 60 s stopped.
      stateMs: states({ Running: 3_300_000, Stopped: 300_000 }),
      stops: [
        { ms: 60_000, wholeMs: 60_000 },
        { ms: 180_000, wholeMs: 180_000 },
        { ms: 60_000, wholeMs: 90_000 },
      ],
      cycles: [
        { product: 'VB-100', result: 'good', count: 1 },
        { product: 'VB-100', result: 'scrap', count: 1 },
      ],
    });
    // PBT 3 600 000; APT = 3 300 000 + micro-stops (60 000 + 60 000) = 3 420 000; ideal 2 × 240 000.
    expect(a?.result).toEqual({
      availability: { fraction: '19/20', decimal: '0.9500' },
      performance: { fraction: '8/57', decimal: '0.1404' },
      quality: { fraction: '1/2', decimal: '0.5000' },
      // (480 000 × 1) / (3 600 000 × 2)
      oee: { fraction: '1/15', decimal: '0.0667' },
      anomaly: false,
      provisional: false,
      totals: {
        plannedBusyMs: 3_600_000,
        actualProductionMs: 3_420_000,
        excludedMs: 0,
        longStopMs: 180_000,
        microStopMs: 120_000,
        idealMs: 480_000,
        good: 1,
        scrap: 1,
        rework: 0,
        produced: 2,
      },
      unplanned: { good: 0, produced: 0, idealMs: 0 },
      losses: {
        availability: {
          own: { stopped: 180_000, down: 0, setup: 0, idle: 0, total: 180_000 },
          external: { starved: 0, blocked: 0, total: 0 },
        },
        // 3 420 000 − 120 000 − 480 000
        performance: { microStops: 120_000, speed: 2_820_000, total: 2_940_000 },
        quality: { fraction: '240000/1', decimal: '240000.0000' },
      },
    });
    expect(oee.machines['cnc-01']?.operation).toBe('OP10');
    expect(oee.machines['cnc-01']?.idealCycleMs).toEqual({ 'VB-100': 240_000, 'VB-200': 330_000 });
    // The hour 10:00 UTC is the same span as the bucket.
    const hour = oee.machines['cnc-01']?.hours['2026-10-12T10:00:00.000Z'];
    expect(hour).toEqual({ shift: '2026-10-12/A', ...a?.inputs });
    // The work center is the sum of its machines; CNC-02 and WSH-01 were off (excluded time).
    const cell = oee.workCenters['cell-m1'];
    expect(cell?.equipment).toEqual(['cnc-01', 'cnc-02', 'wsh-01']);
    expect(cell?.shifts['2026-10-12/A']?.oee).toEqual(a?.result.oee);
    expect(cell?.shifts['2026-10-12/A']?.totals.excludedMs).toBe(2 * 3_600_000);
    // A machine that was off all along has no planned time: everything is null, never 0.
    expect(oee.machines['cnc-02']?.shifts['2026-10-12/A']?.result).toMatchObject({
      availability: null,
      performance: null,
      quality: null,
      oee: null,
      losses: null,
    });
    expect(oee.workCenters['line-a1']?.shifts['2026-10-12/A']?.oee).toBeNull();
  });

  it('buckets a cycle by its time, holds an open stop and runs its whole length to the snapshot', () => {
    const { read } = constructed();
    const early = read(B + 6 * MIN).oee.machines['cnc-01']?.shifts['2026-10-12/B'];
    // The cycle at 11:00:00.000 was recorded before B's shift event, yet it belongs to B.
    expect(early?.inputs.cycles).toEqual([{ product: 'VB-100', result: 'good', count: 1 }]);
    expect(early?.inputs.stops).toEqual([
      { ms: 30_000, wholeMs: 90_000 },
      { ms: 60_000, wholeMs: 60_000, open: true },
    ]);
    expect(early?.inputs.stateMs).toEqual(states({ Running: 270_000, Stopped: 90_000 }));
    // Both stops are below 120 s: APT = PBT = 360 000, and the open one is provisional.
    expect(early?.result).toMatchObject({
      availability: { fraction: '1/1', decimal: '1.0000' },
      performance: { fraction: '2/3', decimal: '0.6667' },
      quality: { fraction: '1/1', decimal: '1.0000' },
      oee: { fraction: '2/3', decimal: '0.6667' },
      provisional: true,
    });

    // Three minutes later the open stop is past the threshold: long, and final.
    const late = read(B + 8 * MIN).oee.machines['cnc-01']?.shifts['2026-10-12/B'];
    expect(late?.inputs.stops.at(-1)).toEqual({ ms: 180_000, wholeMs: 180_000, open: true });
    // PBT 480 000, APT 270 000 + 30 000 = 300 000, ideal 240 000.
    expect(late?.result).toMatchObject({
      availability: { fraction: '5/8', decimal: '0.6250' },
      performance: { fraction: '4/5', decimal: '0.8000' },
      oee: { fraction: '1/2', decimal: '0.5000' },
      provisional: false,
    });
  });

  it('reading snapshots changes nothing that is recorded later', () => {
    const untouched = constructed().read(B + 9 * MIN);
    const probed = constructed([S, S + 10 * MIN, S + 30 * MIN, S + 59 * MIN + 1, B, B + MIN]);
    expect(probed.read(B + 9 * MIN)).toEqual(untouched);
    expect(probed.read(B + 9 * MIN)).toEqual(untouched);
  });
});

describe('golden week OEE section (#117)', () => {
  let golden: GroundTruthSummary;

  beforeAll(async () => {
    golden = JSON.parse(
      await readFile(resolve(import.meta.dirname, '../../golden/week-01/summary.json'), 'utf8'),
    ) as GroundTruthSummary;
  });

  const input = (inputs: BucketInputsJson, operation: string): BucketInput => ({
    ...inputs,
    operation,
    idealCycleMs: idealCycleMs(config),
  });

  it('has hours that sum to their shift bucket, and shift buckets that match byShift and the totals', () => {
    const oee: OeeSummary = golden.oee;
    expect(oee.config).toEqual(config.oee);
    for (const [id, machine] of Object.entries(oee.machines)) {
      const truth = golden.machines[id];
      expect(Object.keys(machine.shifts).sort(), id).toEqual(
        Object.keys(truth?.byShift ?? {}).sort(),
      );
      expect(Object.keys(machine.hours)).toHaveLength(7 * 24);
      const byShift = new Map<string, OeeTotals[]>();
      const cycleTotals = { good: 0, scrap: 0, rework: 0 };
      for (const [iso, hour] of Object.entries(machine.hours)) {
        expect(hour.shift, `${id} ${iso}`).toBe(shiftKeyAt(config.shifts, Date.parse(iso)));
        const totals = bucketTotals(input(hour, machine.operation), config.oee);
        byShift.set(hour.shift, [...(byShift.get(hour.shift) ?? []), totals]);
      }
      for (const [key, bucket] of Object.entries(machine.shifts)) {
        const where = `${id} ${key}`;
        expect(bucket.inputs.stateMs, where).toEqual(truth?.byShift[key]);
        const shiftTotals = bucketTotals(input(bucket.inputs, machine.operation), config.oee);
        // Σ hours = shift, for every input and every derived total (the threshold applies to
        // whole intervals, so classification doesn't depend on the cut).
        expect(sumTotals(byShift.get(key) ?? []), where).toEqual(shiftTotals);
        expect(bucket.result, where).toEqual(
          resultJson(bucketOee(input(bucket.inputs, machine.operation), config.oee)),
        );
        expect(bucket.result.provisional, where).toBe(false);
        for (const c of bucket.inputs.cycles) {
          cycleTotals[c.result] += c.count;
        }
        for (const stop of bucket.inputs.stops) {
          expect(stop.wholeMs).toBeGreaterThanOrEqual(stop.ms);
        }
      }
      expect(cycleTotals, id).toEqual(truth?.cycles);
    }
  });

  it('gives each work center the OEE of its machines summed inputs', () => {
    const oee: OeeSummary = golden.oee;
    for (const [wcId, wc] of Object.entries(oee.workCenters)) {
      expect(Object.keys(wc.shifts)).toHaveLength(16);
      for (const [key, result] of Object.entries(wc.shifts)) {
        const members = wc.equipment.map((id) => {
          const machine = oee.machines[id];
          const bucket = machine?.shifts[key];
          if (!machine || !bucket) throw new Error(`${id} has no ${key}`);
          return { totals: bucket.result.totals, input: input(bucket.inputs, machine.operation) };
        });
        const summed = sumTotals(members.map((m) => bucketTotals(m.input, config.oee)));
        expect(result, `${wcId} ${key}`).toEqual(resultJson(oeeFromTotals(summed)));
        for (const field of Object.keys(result.totals) as (keyof typeof result.totals)[]) {
          expect(result.totals[field], `${wcId} ${key} ${field}`).toBe(
            members.reduce((sum, m) => sum + m.totals[field], 0),
          );
        }
      }
    }
    // Something was actually measured: shift A of Monday has a defined OEE on Line A1.
    expect(oee.workCenters['line-a1']?.shifts['2026-10-12/A']?.oee).not.toBeNull();
    expect(oee.workCenters['line-a1']?.shifts['no-shift']?.oee).toBeNull();
  });
});
