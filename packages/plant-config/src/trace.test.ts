import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatIssues, loadPlantConfig, validatePlantConfig } from './load.ts';
import { PLANT_FILES, type PlantConfig } from './schema.ts';

const DEFAULT_DIR = resolve(import.meta.dirname, '../../../config/plant');

let defaults: Record<string, unknown>;

beforeAll(async () => {
  defaults = Object.fromEntries(
    await Promise.all(
      Object.keys(PLANT_FILES).map(async (file): Promise<[string, unknown]> => [
        file,
        parse(await readFile(join(DEFAULT_DIR, `${file}.yaml`), 'utf8')) as unknown,
      ]),
    ),
  );
});

const messagesFor = (change: (config: PlantConfig) => void): string => {
  const copy = structuredClone(defaults) as PlantConfig;
  change(copy);
  const result = validatePlantConfig(copy);
  return result.ok
    ? ''
    : result.issues.map((issue) => `${issue.file}:${issue.path}: ${issue.message}`).join('\n');
};

describe('packing.yaml and quality.yaml (#208)', () => {
  it('loads the plant defaults: cartons of 20 and 12 at OP50, leak-rate with the ADR-0032 rules', async () => {
    const loaded = await loadPlantConfig(DEFAULT_DIR);
    if (!loaded.ok) throw new Error(formatIssues(loaded.issues));
    expect(loaded.config.packing).toEqual({
      operation: 'OP50',
      capacity: { 'VB-100': 20, 'VB-200': 12 },
    });
    expect(loaded.config.quality.characteristics).toEqual([
      {
        id: 'leak-rate',
        name: 'Leak rate (pressure decay)',
        equipment: 'lkt-01',
        operation: 'OP40',
        subgroupSize: 5,
        baselineSubgroups: 20,
        rules: { I: [1, 2, 5], MR: [], Xbar: [1, 2, 5], R: [1] },
      },
    ]);
  });

  it('refuses a packing operation other than the last, and missing or unknown products', () => {
    expect(
      messagesFor((c) => {
        c.packing.operation = 'OP40';
      }),
    ).toContain("packing:operation: the packing operation must be the routing's last, OP50");
    expect(
      messagesFor((c) => {
        delete c.packing.capacity['VB-200'];
        c.packing.capacity['VB-300'] = 4;
      }),
    ).toBe(
      'packing:capacity: no carton capacity for product "VB-200"\n' +
        'packing:capacity.VB-300: unknown product "VB-300"',
    );
    expect(
      messagesFor((c) => {
        c.packing.capacity['VB-100'] = 0;
      }),
    ).toContain('packing:capacity.VB-100');
  });

  it('refuses a characteristic off the leak test, on the wrong machine, twice, or with bad rules', () => {
    const characteristic = (c: PlantConfig) => {
      const first = c.quality.characteristics[0];
      if (!first) throw new Error('no characteristic');
      return first;
    };
    expect(
      messagesFor((c) => {
        characteristic(c).operation = 'OP30';
        characteristic(c).equipment = 'asm-01';
      }),
    ).toBe(
      'quality:characteristics[0].operation: only the leak test (OP40) is measured, got "OP30"',
    );
    expect(
      messagesFor((c) => {
        characteristic(c).equipment = 'pck-01';
      }),
    ).toBe('quality:characteristics[0].equipment: pck-01 runs OP50, not OP40');
    expect(
      messagesFor((c) => {
        characteristic(c).equipment = 'lkt-09';
      }),
    ).toBe('quality:characteristics[0].equipment: unknown machine "lkt-09"');
    expect(
      messagesFor((c) => {
        c.quality.characteristics.push(structuredClone(characteristic(c)));
      }),
    ).toBe('quality:characteristics[1]: duplicate characteristic "leak-rate"');
    expect(
      messagesFor((c) => {
        characteristic(c).rules = { I: [1, 1], MR: [2], Xbar: [1], R: [1, 5] };
      }),
    ).toBe(
      [
        'quality:characteristics[0].rules.I: a rule is listed twice',
        'quality:characteristics[0].rules.MR: only rule 1 applies to MR',
        'quality:characteristics[0].rules.R: only rule 1 applies to R',
      ].join('\n'),
    );
    expect(
      messagesFor((c) => {
        characteristic(c).subgroupSize = 11;
      }),
    ).toContain('quality:characteristics.0.subgroupSize');
  });
});
