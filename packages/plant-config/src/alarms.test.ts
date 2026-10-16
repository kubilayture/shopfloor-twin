import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { plantAlarms } from './alarms.ts';
import { formatIssues, loadPlantConfig, validatePlantConfig } from './load.ts';
import { PLANT_FILES, type PlantConfig } from './schema.ts';

const DEFAULT_DIR = resolve(import.meta.dirname, '../../../config/plant');

type Raw = Record<keyof typeof PLANT_FILES, unknown>;

let defaults: Raw;

beforeAll(async () => {
  const entries = await Promise.all(
    Object.keys(PLANT_FILES).map(async (file) => [
      file,
      parse(await readFile(join(DEFAULT_DIR, `${file}.yaml`), 'utf8')) as unknown,
    ]),
  );
  defaults = Object.fromEntries(entries) as Raw;
});

const messages = (change: (config: PlantConfig) => void): string[] => {
  const copy = structuredClone(defaults) as PlantConfig;
  change(copy);
  const result = validatePlantConfig(copy);
  return result.ok
    ? []
    : result.issues.map((issue) => `${issue.file}:${issue.path}: ${issue.message}`);
};

describe('alarms.yaml (#139, ADR-0024)', () => {
  it('defines every alarm the default plant can raise, with the plan priorities', async () => {
    const result = await loadPlantConfig(DEFAULT_DIR);
    if (!result.ok) {
      throw new Error(formatIssues(result.issues));
    }
    const { alarms } = result.config;
    expect(
      plantAlarms(result.config).map((p) => `${p.equipment}/${p.code}:${String(p.severity)}`),
    ).toEqual([
      'cnc-01/SPINDLE-OVERLOAD:700',
      'cnc-01/COOLANT-PRESSURE:700',
      'cnc-02/SPINDLE-OVERLOAD:700',
      'cnc-02/COOLANT-PRESSURE:700',
      'wsh-01/HEATER-FAULT:700',
      'asm-01/PRESS-FAULT:700',
      'lkt-01/FIXTURE-SEAL:700',
      'pck-01/PRINTER-FAULT:700',
      'lkt-01/CALIBRATION-DUE:300',
    ]);
    const priority = Object.fromEntries(
      alarms.definitions.map((d) => [`${d.equipment}/${d.code}`, d.priority]),
    );
    expect(priority).toEqual({
      'cnc-01/SPINDLE-OVERLOAD': 'high',
      'cnc-01/COOLANT-PRESSURE': 'medium',
      'cnc-02/SPINDLE-OVERLOAD': 'high',
      'cnc-02/COOLANT-PRESSURE': 'medium',
      'wsh-01/HEATER-FAULT': 'high',
      'asm-01/PRESS-FAULT': 'medium',
      'lkt-01/FIXTURE-SEAL': 'medium',
      'lkt-01/CALIBRATION-DUE': 'low',
      'pck-01/PRINTER-FAULT': 'medium',
    });
    expect(alarms.kpi).toEqual({
      floodThreshold: 10,
      windowMs: 600_000,
      chatterCount: 3,
      chatterWindowMs: 60_000,
      fleetingMs: 1_000,
      standingMs: 86_400_000,
    });
    expect(alarms.maxShelveMs).toBe(28_800_000);
    expect(alarms.positions.map((p) => [p.id, p.workCenters])).toEqual([
      ['cell-m1', ['cell-m1']],
      ['line-a1', ['line-a1']],
    ]);
  });

  it('covers the washer codes of the Modbus alarm table', async () => {
    const result = await loadPlantConfig(DEFAULT_DIR);
    if (!result.ok) {
      throw new Error(formatIssues(result.issues));
    }
    const washer = result.config.process.processValues.washer.machine;
    const defined = result.config.alarms.definitions
      .filter((d) => d.equipment === washer)
      .map((d) => d.code);
    for (const mode of result.config.failures.equipment[washer]?.failureModes ?? []) {
      expect(defined).toContain(mode.code);
    }
  });

  it.each<[string, (c: PlantConfig) => void, string]>([
    [
      'a raisable alarm without a definition',
      (c) => {
        c.alarms.definitions = c.alarms.definitions.filter((d) => d.code !== 'CALIBRATION-DUE');
      },
      'alarms:definitions: no definition for lkt-01/CALIBRATION-DUE, which the plant can raise',
    ],
    [
      'a new failure mode without a definition',
      (c) => {
        c.failures.equipment['asm-01']?.failureModes.push({
          code: 'TORQUE-FAULT',
          weibullShape: 1,
          weibullScaleHours: 100,
          repairMedianMinutes: 10,
          repairSpread: 0.5,
        });
      },
      'no definition for asm-01/TORQUE-FAULT',
    ],
    [
      'a definition on unknown equipment',
      (c) => {
        c.alarms.definitions.push({ equipment: 'cnc-09', code: 'X', priority: 'low', text: 'x' });
      },
      'alarms:definitions[9]: unknown equipment "cnc-09"',
    ],
    [
      'a duplicate definition',
      (c) => {
        const first = c.alarms.definitions[0];
        if (first) c.alarms.definitions.push({ ...first });
      },
      'duplicate definition for cnc-01/SPINDLE-OVERLOAD',
    ],
    [
      'a window that does not divide an hour',
      (c) => {
        c.alarms.kpi.windowMs = 700_000;
      },
      'alarms:kpi.windowMs: the window must divide an hour',
    ],
    [
      'a shelving limit under a minute',
      (c) => {
        c.alarms.maxShelveMs = 59_999;
      },
      'alarms:maxShelveMs',
    ],
    [
      'benchmarks out of order',
      (c) => {
        c.alarms.benchmarks.manageablePer10Min = 0.5;
      },
      'alarms:benchmarks.manageablePer10Min',
    ],
    [
      'inverted benchmarks',
      (c) => {
        c.alarms.benchmarks.manageablePer10Min = 1;
        c.alarms.benchmarks.acceptablePer10Min = 2;
      },
      'the manageable rate is below the acceptable rate',
    ],
    [
      'an unknown work center in a position',
      (c) => {
        c.alarms.positions[0]?.workCenters.push('cell-m9');
      },
      'unknown work center "cell-m9"',
    ],
    [
      'a work center in two positions',
      (c) => {
        c.alarms.positions[0]?.workCenters.push('line-a1');
      },
      'work center "line-a1" is already in position "cell-m1"',
    ],
    [
      'a work center in no position',
      (c) => {
        c.alarms.positions = c.alarms.positions.slice(0, 1);
      },
      'work center "line-a1" is in no position',
    ],
    [
      'a position named plant',
      (c) => {
        const first = c.alarms.positions[0];
        if (first) first.id = 'plant';
      },
      'position id "plant" is reserved or duplicate',
    ],
    [
      'an unknown priority',
      (c) => {
        Object.assign(c.alarms.definitions[0] ?? {}, { priority: 'urgent' });
      },
      'alarms:definitions.0.priority',
    ],
  ])('refuses %s', (_case, change, expected) => {
    expect(messages(change).join('\n')).toContain(expected);
  });
});
