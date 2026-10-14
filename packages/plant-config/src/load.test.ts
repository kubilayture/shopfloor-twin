import { mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
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
  ])('reports %s', (_case, change, expected) => {
    expect(messagesFor(modified(change)).join('\n')).toContain(expected);
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
