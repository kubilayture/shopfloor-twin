import { mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { isWholeMilliseconds } from './cross-check.ts';
import { formatIssues, loadPlantConfig, validatePlantConfig } from './load.ts';
import {
  PLANT_FILES,
  SIMULATION_FILES,
  idealCycleMs,
  simulationSections,
  type PlantConfig,
} from './schema.ts';

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

const modified = (change: (config: PlantConfig) => void): Raw => {
  const copy = structuredClone(defaults) as PlantConfig;
  change(copy);
  return copy;
};

const messagesFor = (raw: Raw): string[] => {
  const result = validatePlantConfig(raw);
  return result.ok
    ? []
    : result.issues.map((issue) => `${issue.file}:${issue.path}: ${issue.message}`);
};

describe('default plant configuration', () => {
  it('loads and validates', async () => {
    const result = await loadPlantConfig(DEFAULT_DIR);
    expect(result.ok ? [] : formatIssues(result.issues)).toEqual([]);
  });

  it('matches plan section 3', async () => {
    const result = await loadPlantConfig(DEFAULT_DIR);
    if (!result.ok) {
      throw new Error(formatIssues(result.issues));
    }
    const { plant, products } = result.config;
    const equipment = plant.areas.flatMap((a) => a.workCenters.flatMap((w) => w.equipment));
    expect(equipment.map((e) => `${e.id}:${e.operation}:${e.interface}`)).toEqual([
      'cnc-01:OP10:opcua',
      'cnc-02:OP10:opcua',
      'wsh-01:OP20:modbus',
      'asm-01:OP30:opcua',
      'lkt-01:OP40:opcua',
      'pck-01:OP50:opcua',
    ]);
    expect(plant.buffers.map((b) => b.capacity)).toEqual([20, 30, 5, 10]);
    expect(products.changeoverMinutes).toBe(25);
    expect(
      products.products.map((p) => [p.id, p.idealCycleSeconds.OP10, p.idealCycleSeconds.OP30]),
    ).toEqual([
      ['VB-100', 240, 150],
      ['VB-200', 330, 210],
    ]);
  });
});

describe('schema errors', () => {
  it.each<[string, (c: PlantConfig) => void, string]>([
    ['an unknown key', (c) => Object.assign(c.plant, { extra: 1 }), 'plant:'],
    [
      'an id that is not kebab-case',
      (c) => {
        const area = c.plant.areas[0];
        if (area) area.id = 'Machining';
      },
      'plant:areas.0.id: lower-case kebab-case id',
    ],
    [
      'a negative buffer capacity',
      (c) => {
        const buffer = c.plant.buffers[0];
        if (buffer) buffer.capacity = -1;
      },
      'plant:buffers.0.capacity',
    ],
    [
      'a malformed shift time',
      (c) => {
        const shift = c.shifts.shifts[0];
        if (shift) shift.start = '6:00';
      },
      'shifts:shifts.0.start: time of day as HH:MM',
    ],
    [
      'a probability above 1',
      (c) => {
        c.operators.absenceProbabilityPerShift = 1.5;
      },
      'operators:absenceProbabilityPerShift',
    ],
  ])('reports %s with file and path', (_case, change, expected) => {
    expect(messagesFor(modified(change)).join('\n')).toContain(expected);
  });
});

describe('cross-file checks', () => {
  it.each<[string, (c: PlantConfig) => void, string]>([
    [
      'a duplicate equipment id',
      (c) => {
        const equipment = c.plant.areas[0]?.workCenters[0]?.equipment;
        const first = equipment?.[0];
        if (equipment && first) equipment.push({ ...first });
      },
      'duplicate equipment id "cnc-01"',
    ],
    [
      'equipment on an unknown operation',
      (c) => {
        const item = c.plant.areas[0]?.workCenters[0]?.equipment[0];
        if (item) item.operation = 'OP99';
      },
      'unknown operation "OP99"',
    ],
    [
      'a buffer between non-consecutive operations',
      (c) => {
        const buffer = c.plant.buffers[0];
        if (buffer) buffer.to = 'OP30';
      },
      'does not join two consecutive operations',
    ],
    [
      'a product without a cycle time for every operation',
      (c) => {
        const product = c.products.products[0];
        if (product) delete product.idealCycleSeconds.OP40;
      },
      'missing ideal cycle time for OP40',
    ],
    [
      'a break that runs past the end of the shift',
      (c) => {
        const shift = c.shifts.shifts[0];
        if (shift) shift.break = { start: '13:45', minutes: 30 };
      },
      'break does not fit inside the shift',
    ],
    [
      'two shifts that overlap',
      (c) => {
        const shift = c.shifts.shifts[1];
        if (shift) shift.start = '13:00';
      },
      'overlaps shift "A"',
    ],
    [
      'an unknown time zone',
      (c) => {
        c.shifts.timeZone = 'Europe/Gebze';
      },
      'unknown time zone "Europe/Gebze"',
    ],
    [
      'a station that needs an operator nobody is qualified for',
      (c) => {
        c.operators.operators = c.operators.operators.map((op) => ({ ...op, skills: ['lkt-01'] }));
      },
      'no operator is qualified for "asm-01"',
    ],
    [
      'an operator on an unknown shift',
      (c) => {
        const operator = c.operators.operators[0];
        if (operator) operator.shift = 'D';
      },
      'unknown shift "D"',
    ],
    [
      'an operator skilled on an unknown station',
      (c) => {
        const operator = c.operators.operators[0];
        if (operator) operator.skills = ['asm-99'];
      },
      'unknown station "asm-99"',
    ],
    [
      'failure data for unknown equipment',
      (c) => {
        const cnc = c.failures.equipment['cnc-01'];
        if (cnc) c.failures.equipment['cnc-09'] = cnc;
      },
      'unknown equipment "cnc-09"',
    ],
    [
      'an operation without cycle-time variation',
      (c) => {
        delete c.process.cycleTimeCv.OP20;
      },
      'missing coefficient of variation for OP20',
    ],
    [
      'a defect curve that does not rise from 0 to 1',
      (c) => {
        c.process.tool.defectProbability = [
          { wear: 0, probability: 0.1 },
          { wear: 0.5, probability: 0.2 },
        ];
      },
      'wear points must rise strictly from 0 to 1',
    ],
    [
      'a rework component that is not a component',
      (c) => {
        const product = c.products.products[0];
        if (product) product.reworkComponents = ['SP-200'];
      },
      '"SP-200" is not a component of VB-100',
    ],
    [
      'components consumed at an unknown operation',
      (c) => {
        c.products.componentsOperation = 'OP77';
      },
      'componentsOperation: unknown operation "OP77"',
    ],
    [
      'a sensor resolution that is not a power of ten',
      (c) => {
        c.process.processValues.coolant.resolution = 0.25;
      },
      'processValues.coolant.resolution'.replace('processValues.', '') +
        ': resolution must be a power of ten',
    ],
    [
      'process values for unknown equipment',
      (c) => {
        c.process.processValues.machines = ['cnc-77'];
      },
      'processValues.machines: unknown equipment "cnc-77"',
    ],
    [
      'a washer that is not equipment',
      (c) => {
        c.process.processValues.washer.machine = 'wsh-77';
      },
      'processValues.washer.machine: unknown equipment "wsh-77"',
    ],
    [
      'a heater fault that is not a failure mode of the washer',
      (c) => {
        c.process.processValues.washer.heaterFaultCode = 'NO-SUCH-FAULT';
      },
      'processValues.washer.heaterFaultCode: "NO-SUCH-FAULT" is not a failure mode of wsh-01',
    ],
    [
      'a leak test on an unknown operation',
      (c) => {
        c.process.leakTest.operation = 'OP99';
      },
      'leakTest.operation: unknown operation "OP99"',
    ],
    [
      'a duplicate lot id',
      (c) => {
        const lot = c.stock.lots[0];
        if (lot) c.stock.lots.push({ ...lot });
      },
      'duplicate lot id "BL100-2610-01"',
    ],
    [
      'a lot of a material no product uses',
      (c) => {
        c.stock.lots.push({ id: 'XX-1', material: 'UNOBTAINIUM', quantity: 1 });
      },
      'material "UNOBTAINIUM" is used by no product',
    ],
    [
      'a schedule on a machine that is not OP10',
      (c) => {
        c.schedule.machines['asm-01'] = [{ product: 'VB-100', quantity: 1 }];
      },
      '"asm-01" is not a OP10 machine',
    ],
    [
      'a schedule for an unknown product',
      (c) => {
        c.schedule.machines['cnc-01'] = [{ product: 'VB-999', quantity: 1 }];
      },
      'unknown product "VB-999"',
    ],
    [
      'a shift that starts off the hour',
      (c) => {
        const shift = c.shifts.shifts[0];
        if (shift) shift.start = '06:30';
      },
      'shifts:A.start: shifts must start and end on whole hours',
    ],
    [
      'a shift that ends off the hour',
      (c) => {
        const shift = c.shifts.shifts[2];
        if (shift) shift.end = '05:45';
      },
      'shifts:C.end: shifts must start and end on whole hours',
    ],
    [
      'a time zone with a half-hour offset',
      (c) => {
        c.shifts.timeZone = 'Asia/Kolkata';
      },
      'shifts:timeZone: "Asia/Kolkata" has a UTC offset that is not whole hours',
    ],
    [
      'an ideal cycle time that is not whole milliseconds',
      (c) => {
        const product = c.products.products[0];
        if (product) product.idealCycleSeconds.OP20 = 60.0005;
      },
      'products:VB-100.idealCycleSeconds.OP20: ideal cycle time must be whole milliseconds',
    ],
  ])('reports %s', (_case, change, expected) => {
    expect(messagesFor(modified(change)).join('\n')).toContain(expected);
  });
});

describe('OEE configuration (ADR-0021)', () => {
  it('loads the threshold and the scheduled-time rule', async () => {
    const result = await loadPlantConfig(DEFAULT_DIR);
    expect(result.ok && result.config.oee).toEqual({
      microStopThresholdMs: 120_000,
      scheduledTime: 'shift-calendar',
    });
  });

  it.each<[string, (c: PlantConfig) => void, string]>([
    [
      'a fractional threshold',
      (c) => {
        c.oee.microStopThresholdMs = 1.5;
      },
      'oee:microStopThresholdMs',
    ],
    [
      'a zero threshold',
      (c) => {
        c.oee.microStopThresholdMs = 0;
      },
      'oee:microStopThresholdMs',
    ],
    [
      'an unknown scheduled-time rule',
      (c) => {
        Object.assign(c.oee, { scheduledTime: 'orders' });
      },
      'oee:scheduledTime',
    ],
  ])('reports %s', (_case, change, expected) => {
    expect(messagesFor(modified(change)).join('\n')).toContain(expected);
  });

  it('accepts ideal times with up to three decimals and converts them to exact milliseconds', async () => {
    const result = await loadPlantConfig(DEFAULT_DIR);
    if (!result.ok) {
      throw new Error(formatIssues(result.issues));
    }
    expect(idealCycleMs(result.config)['VB-200']).toEqual({
      OP10: 330_000,
      OP20: 60_000,
      OP30: 210_000,
      OP40: 90_000,
      OP50: 30_000,
    });
    expect(isWholeMilliseconds(1.005)).toBe(true);
    expect(isWholeMilliseconds(0.001)).toBe(true);
    expect(isWholeMilliseconds(1e-7)).toBe(false);
    const product = result.config.products.products[0];
    if (product) product.idealCycleSeconds.OP10 = 1.005;
    expect(idealCycleMs(result.config)['VB-100']?.OP10).toBe(1005);
  });

  it('keeps the simulation sections apart from the OEE, reason and alarm sections', async () => {
    const result = await loadPlantConfig(DEFAULT_DIR);
    if (!result.ok) {
      throw new Error(formatIssues(result.issues));
    }
    const sections = simulationSections(result.config);
    expect(Object.keys(sections).sort()).toEqual(Object.keys(SIMULATION_FILES).sort());
    expect(sections).not.toHaveProperty('oee');
    expect(sections).not.toHaveProperty('reasons');
    expect(sections).not.toHaveProperty('alarms');
    expect(Object.keys(PLANT_FILES)).toEqual([
      ...Object.keys(SIMULATION_FILES),
      'oee',
      'reasons',
      'alarms',
    ]);
  });
});

describe('loading files', () => {
  it('reports a missing file and invalid YAML by file name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plant-config-'));
    try {
      await cp(DEFAULT_DIR, dir, { recursive: true });
      await rm(join(dir, 'stock.yaml'));
      await writeFile(join(dir, 'shifts.yaml'), 'timeZone: [unclosed');
      const result = await loadPlantConfig(dir);
      expect(result.ok).toBe(false);
      const text = result.ok ? '' : formatIssues(result.issues);
      expect(text).toContain('stock.yaml: ');
      expect(text).toContain('shifts.yaml: ');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
