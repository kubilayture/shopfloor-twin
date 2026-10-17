/**
 * Scenario inputs of Phase 8 (#196, ADR-0033): a scenario's own stock file and the `leak-drift`
 * injection in a scenario's `injections`, with the run header listing a drift only when a run has
 * one (a header entry without `kind` stays a failure injection).
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HOUR } from '@shopfloor/sim-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readScenario,
  scenarioNames,
  scenarioOptions,
  scenarioStock,
  type Scenario,
} from './golden.ts';
import { configHash, runHeadless } from './run.ts';

const GOLDEN = resolve(import.meta.dirname, '../../golden');
const REPO = resolve(import.meta.dirname, '../../../..');

let folder: string;

const SMALL_LOTS = `lots:
  - { id: BL100-Q-01, material: BLANK-100, quantity: 7 }
  - { id: BL100-Q-02, material: BLANK-100, quantity: 900 }
  - { id: BL200-Q-01, material: BLANK-200, quantity: 900 }
  - { id: SK1-Q-01, material: SK-1, quantity: 4 }
  - { id: SK1-Q-02, material: SK-1, quantity: 900 }
  - { id: SK2-Q-01, material: SK-2, quantity: 900 }
  - { id: SP100-Q-01, material: SP-100, quantity: 900 }
  - { id: SP200-Q-01, material: SP-200, quantity: 900 }
`;

const scenario = {
  seed: 20261012,
  start: '2026-10-12T06:00:00+03:00',
  days: 0.25,
  config: 'config/plant',
  stock: 'stock.yaml',
  injections: [
    { at: '2026-10-12T04:00:05Z', machine: 'cnc-01', code: 'COOLANT-PRESSURE', repairMs: 3000 },
    {
      kind: 'leak-drift',
      at: '2026-10-12T04:30:00Z',
      until: '2026-10-12T05:00:00Z',
      machine: 'lkt-01',
      shift: 0.6,
    },
    {
      kind: 'leak-drift',
      at: '2026-10-12T08:00:00Z',
      // Shift A ends at 11:00Z, a calendar boundary, but also after this run's end (09:00Z).
      until: '2026-10-12T11:00:00Z',
      machine: 'lkt-01',
      shift: -0.2,
    },
  ],
} satisfies Scenario;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'sim-scenarios-'));
  await mkdir(join(folder, 'small'));
  await writeFile(join(folder, 'small', 'scenario.json'), JSON.stringify(scenario));
  await writeFile(join(folder, 'small', 'stock.yaml'), SMALL_LOTS);
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('scenario-local stock (#196)', () => {
  it("runs a scenario on its own stock file, and the header's configSha256 hashes it", async () => {
    const options = await scenarioOptions('small', folder);
    expect(options.config.stock.lots.map((lot) => lot.id)).toContain('BL100-Q-01');
    const plant = await scenarioOptions('week-01');
    expect(configHash(options.config)).not.toBe(configHash(plant.config));
    const lines: string[] = [];
    const result = runHeadless(options, (line) => lines.push(line));
    const consumed = lines
      .map((line) => JSON.parse(line) as { type?: string; lotId?: string })
      .filter((event) => event.type === 'material-consumed');
    // The small first lots run out inside the run, and the next lot of the material follows.
    expect(new Set(consumed.map((event) => event.lotId))).toEqual(
      new Set(['BL100-Q-01', 'BL100-Q-02', 'SK1-Q-01', 'SK1-Q-02', 'SP100-Q-01']),
    );
    expect(result.summary.lots['BL100-Q-01']).toBe(0);
    expect(result.summary.lots['SK1-Q-01']).toBe(0);
  });

  it('takes only a file name of the scenario folder', () => {
    expect(scenarioStock('small', { ...scenario, stock: 'stock.yaml' }, folder)).toBe(
      join(folder, 'small', 'stock.yaml'),
    );
    for (const stock of ['../stock.yaml', '/etc/stock.yaml', 'sub/stock.yaml', '.hidden.yaml']) {
      expect(() => scenarioStock('small', { ...scenario, stock }, folder)).toThrow(
        /a file name in the scenario's folder/,
      );
    }
    expect(scenarioStock('week-01')).toBeUndefined();
  });

  it("gives every golden scenario with an ERP dataset the dataset's lots as its stock", async () => {
    const plantStock = (await scenarioOptions('week-01')).config.stock.lots;
    for (const name of scenarioNames()) {
      const erp = readScenario(name).erp;
      if (!erp) continue;
      const dataset = JSON.parse(readFileSync(join(GOLDEN, name, erp.dataset), 'utf8')) as {
        lots?: unknown;
      };
      const { config } = await scenarioOptions(name);
      expect(dataset.lots ?? plantStock, name).toEqual(config.stock.lots);
    }
    expect(existsSync(join(REPO, 'config/plant/stock.yaml'))).toBe(true);
  });
});

describe('leak-drift in a scenario (#196)', () => {
  it('lists a drift in the header with its kind, and writes applied and ended lines', async () => {
    const options = await scenarioOptions('small', folder);
    const lines: string[] = [];
    const result = runHeadless(options, (line) => lines.push(line));
    expect(result.header.injections).toEqual([
      {
        at: '2026-10-12T04:00:05.000Z',
        machine: 'cnc-01',
        code: 'COOLANT-PRESSURE',
        repairMs: 3000,
      },
      {
        kind: 'leak-drift',
        at: '2026-10-12T04:30:00.000Z',
        until: '2026-10-12T05:00:00.000Z',
        machine: 'lkt-01',
        shift: 0.6,
      },
      {
        kind: 'leak-drift',
        at: '2026-10-12T08:00:00.000Z',
        until: '2026-10-12T11:00:00.000Z',
        machine: 'lkt-01',
        shift: -0.2,
      },
    ]);
    const drifts = lines
      .slice(1)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === 'leak-drift')
      .map((event) => ({ ...event, seq: typeof event.seq }));
    expect(drifts).toEqual([
      {
        type: 'leak-drift',
        schema: 'sim-event/1',
        seq: 'number',
        at: '2026-10-12T04:30:00.000Z',
        machineId: 'lkt-01',
        injection: 2,
        transition: 'applied',
        shift: 0.6,
      },
      {
        type: 'leak-drift',
        schema: 'sim-event/1',
        seq: 'number',
        at: '2026-10-12T05:00:00.000Z',
        machineId: 'lkt-01',
        injection: 2,
        transition: 'ended',
        shift: 0.6,
        endedBy: 'until',
      },
      {
        type: 'leak-drift',
        schema: 'sim-event/1',
        seq: 'number',
        at: '2026-10-12T08:00:00.000Z',
        machineId: 'lkt-01',
        injection: 3,
        transition: 'applied',
        shift: -0.2,
      },
    ]);
  });

  it('refuses an injection kind it does not know', async () => {
    await mkdir(join(folder, 'odd'));
    await writeFile(
      join(folder, 'odd', 'scenario.json'),
      JSON.stringify({
        ...scenario,
        stock: undefined,
        injections: [{ kind: 'pressure-drift', at: '2026-10-12T04:30:00Z', machine: 'lkt-01' }],
      }),
    );
    await expect(scenarioOptions('odd', folder)).rejects.toThrow(
      'odd/scenario.json: injections[0]: unknown kind "pressure-drift" (a failure injection has no kind; a drift is "leak-drift")',
    );
  });

  it('refuses a drift outside the run, and an until on a boundary inside it', async () => {
    const options = await scenarioOptions('small', folder);
    const drift = {
      kind: 'leak-drift' as const,
      machine: 'lkt-01',
      shift: 0.6,
      at: options.start + HOUR + 1,
      until: options.start + 2 * HOUR + 1,
    };
    const run = (injection: typeof drift) => () =>
      runHeadless({ ...options, injections: [injection] }, () => undefined);
    expect(run(drift)).not.toThrow();
    expect(run({ ...drift, at: options.end, until: options.end + 1 })).toThrow(/outside the run/);
    // The break starts at 07:00Z, inside the run.
    expect(run({ ...drift, until: Date.parse('2026-10-12T07:00:00Z') })).toThrow(
      /calendar boundary/,
    );
  });
});
