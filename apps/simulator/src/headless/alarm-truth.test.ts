import { bucketKpis, composeBuckets, hoursOf, type Occurrence } from '@shopfloor/alarm-core';
import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlantEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { AlarmTruth } from './alarm-truth.ts';
import { scenarioOptions } from './golden.ts';
import { runHeadless } from './run.ts';

const START = Date.UTC(2026, 9, 12, 3);
let config: PlantConfig;

beforeAll(async () => {
  config = await loadDefaultConfig();
});

const alarm = (
  machineId: string,
  code: string,
  transition: 'active' | 'cleared',
  at: number,
  severity = 700,
): PlantEvent => ({ type: 'alarm', at, machineId, code, transition, severity });

describe('alarm ground truth (#140)', () => {
  it('pairs raises and clears, takes priorities from alarms.yaml and falls back to severity', () => {
    const truth = new AlarmTruth(config, START);
    truth.record(alarm('cnc-01', 'SPINDLE-OVERLOAD', 'active', START + 10));
    truth.record(alarm('cnc-01', 'SPINDLE-OVERLOAD', 'cleared', START + 500));
    truth.record(alarm('pck-01', 'PRINTER-FAULT', 'active', START + 20));
    truth.record(alarm('pck-01', 'UNKNOWN-CODE', 'active', START + 20, 300));
    const summary = truth.summary(START + 2 * HOUR);
    expect(summary.occurrences).toEqual([
      {
        equipment: 'cnc-01',
        code: 'SPINDLE-OVERLOAD',
        priority: 'high',
        severity: 700,
        raisedAt: '2026-10-12T03:00:00.010Z',
        clearedAt: '2026-10-12T03:00:00.500Z',
        endReason: 'cleared',
      },
      {
        equipment: 'pck-01',
        code: 'PRINTER-FAULT',
        priority: 'medium',
        severity: 700,
        raisedAt: '2026-10-12T03:00:00.020Z',
        clearedAt: null,
        endReason: null,
      },
      {
        equipment: 'pck-01',
        code: 'UNKNOWN-CODE',
        priority: 'low',
        severity: 300,
        raisedAt: '2026-10-12T03:00:00.020Z',
        clearedAt: null,
        endReason: null,
      },
    ]);
    const plant = summary.scopes.plant;
    // A fleeting raise (490 ms), two still active; both hours listed (active time in both).
    expect(Object.keys(plant?.hours ?? {})).toEqual([
      '2026-10-12T03:00:00.000Z',
      '2026-10-12T04:00:00.000Z',
    ]);
    expect(plant?.hours['2026-10-12T03:00:00.000Z']).toMatchObject({
      raises: 3,
      byPriority: { high: 1, medium: 1, low: 1 },
      fleeting: 1,
      activeAtEnd: 2,
      averageRate: { fraction: '1/2', decimal: '0.5000' },
    });
    expect(summary.scopes['cell-m1']?.shifts['2026-10-12/A']?.raises).toBe(1);
    expect(summary.scopes['line-a1']?.shifts['2026-10-12/A']?.raises).toBe(2);
    expect(summary.positions).toEqual({
      'cell-m1': { workCenters: ['cell-m1'] },
      'line-a1': { workCenters: ['line-a1'] },
    });
    // The hour not yet over is provisional; the summary is read-only.
    expect(truth.summary(START + HOUR + 1).scopes.plant?.shifts['2026-10-12/A']?.provisional).toBe(
      true,
    );
    expect(truth.summary(START + 2 * HOUR)).toEqual(summary);
  });

  it('keys no-shift stretches by the calendar and composes every bucket from its hours', async () => {
    const options = await scenarioOptions('week-01');
    const result = runHeadless(options, () => undefined);
    const { alarms } = result.summary;
    const plant = alarms.scopes.plant;
    if (!plant) throw new Error('no plant scope');
    const keys = Object.keys(plant.shifts);
    expect(keys).toHaveLength(16);
    // Friday's shift C ends on Saturday 06:00 Istanbul; the run ends on Monday 06:00.
    expect(keys).toContain('no-shift/2026-10-17T03:00:00.000Z');
    expect(plant.shifts['no-shift/2026-10-17T03:00:00.000Z']).toMatchObject({
      from: '2026-10-17T03:00:00.000Z',
      to: '2026-10-19T03:00:00.000Z',
      windows: 288,
    });
    // The golden week's two alarms, both on CNC-01.
    expect(alarms.occurrences.map((o) => [o.code, o.raisedAt, o.clearedAt])).toEqual([
      ['COOLANT-PRESSURE', '2026-10-13T15:34:47.821Z', '2026-10-13T16:02:29.720Z'],
      ['SPINDLE-OVERLOAD', '2026-10-14T14:38:37.501Z', '2026-10-14T15:08:42.755Z'],
    ]);
    // A shift computed directly over its whole range equals the composition of its hours.
    const occurrences: Occurrence[] = alarms.occurrences.map((o, i) => ({
      equipment: o.equipment,
      code: o.code,
      priority: o.priority,
      seq: i + 1,
      raisedAt: Date.parse(o.raisedAt),
      clearedAt: o.clearedAt === null ? null : Date.parse(o.clearedAt),
    }));
    const shiftB = { from: Date.UTC(2026, 9, 13, 11), to: Date.UTC(2026, 9, 13, 19) };
    const horizon = { asOf: options.end };
    const [direct] = bucketKpis(occurrences, [shiftB], horizon, alarms.config);
    const composed = composeBuckets(
      bucketKpis(occurrences, hoursOf(shiftB), horizon, alarms.config),
      alarms.config,
    );
    expect(composed).toEqual(direct);
    expect(plant.shifts['2026-10-13/B']).toMatchObject({ raises: 1, activeMs: direct?.activeMs });
  });
});
