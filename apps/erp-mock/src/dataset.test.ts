import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { erpOrderSchema, lotSchema } from '@shopfloor/contracts/erp-api';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDataset, masterDataFrom } from './dataset.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const PLANT = join(REPO, 'config/plant');
const DATASET = join(REPO, 'config/erp/orders.yaml');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'erp-dataset-'));
  dirs.push(dir);
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}

async function plant(): Promise<PlantConfig> {
  const loaded = await loadPlantConfig(PLANT);
  if (!loaded.ok) throw new Error('plant config invalid');
  return loaded.config;
}

describe('dataset', () => {
  it('serves config/erp/orders.yaml with routings and BOMs from the plant configuration', async () => {
    const dataset = await loadDataset(DATASET, PLANT);
    expect(dataset.feed.length).toBeGreaterThanOrEqual(5);
    for (const entry of dataset.feed)
      expect(erpOrderSchema.parse(entry.order)).toEqual(entry.order);
    const vb100 = dataset.feed.find((e) => e.order.product === 'VB-100')?.order;
    expect(vb100?.routing).toEqual([
      { operation: 'OP10', workCenter: 'cell-m1' },
      { operation: 'OP20', workCenter: 'cell-m1' },
      { operation: 'OP30', workCenter: 'line-a1' },
      { operation: 'OP40', workCenter: 'line-a1' },
      { operation: 'OP50', workCenter: 'line-a1' },
    ]);
    expect(vb100?.bom).toEqual([
      { material: 'BLANK-100', operation: 'OP10', quantityPerUnit: 1, usage: 'standard' },
      { material: 'SK-1', operation: 'OP30', quantityPerUnit: 1, usage: 'standard' },
      { material: 'SP-100', operation: 'OP30', quantityPerUnit: 1, usage: 'standard' },
      { material: 'SK-1', operation: 'OP30', quantityPerUnit: 1, usage: 'rework' },
    ]);
    // A revision before release is part of the dev dataset.
    const numbers = dataset.feed.map((e) => e.order.orderNumber);
    expect(new Set(numbers).size).toBeLessThan(numbers.length);
    // Lots are the plant's stock.yaml, as the simulator stocks them.
    const config = await plant();
    expect(dataset.lots).toEqual(config.stock.lots);
    for (const lot of dataset.lots) expect(lotSchema.parse(lot)).toEqual(lot);
  });

  it('reads a scenario dataset in JSON', async () => {
    const path = file(
      'orders.json',
      JSON.stringify({
        orders: [
          {
            orderNumber: 'G-1',
            revision: 1,
            product: 'VB-200',
            quantity: 3,
            plannedStart: '2026-10-12T06:00:00+03:00',
            dueDate: '2026-10-12T14:00:00+03:00',
          },
        ],
        lots: [{ id: 'BL200-X', material: 'BLANK-200', quantity: 3 }],
      }),
    );
    const dataset = await loadDataset(path, PLANT);
    expect(dataset.feed).toHaveLength(1);
    expect(dataset.lots).toEqual([{ id: 'BL200-X', material: 'BLANK-200', quantity: 3 }]);
  });

  it("serves the golden scenario orders-01's dataset as it is (#175)", async () => {
    // orders-01's orders.json is in the dataset schema, so the ERP mock serves it unchanged.
    const golden = await loadDataset(
      join(REPO, 'apps/simulator/golden/orders-01/orders.json'),
      PLANT,
    );
    expect(golden.feed.map((e) => [e.feedSeq, e.order.orderNumber, e.order.revision])).toEqual([
      [1, 'PO-2610-001', 1],
      [2, 'PO-2610-002', 1],
      [3, 'PO-2610-003', 1],
      [4, 'PO-2610-004', 1],
      [5, 'PO-2610-005', 1],
      [6, 'PO-2610-006', 1],
      [7, 'PO-2610-007', 1],
      [8, 'PO-2610-008', 1],
      [9, 'PO-2610-009', 1],
      [10, 'PO-2610-006', 2],
    ]);
    expect(golden.lots).toEqual((await plant()).stock.lots);
  });

  it('names the file and the entry of an invalid dataset', async () => {
    const path = file('bad.yaml', 'orders:\n  - { orderNumber: X-1 }\n');
    await expect(loadDataset(path, PLANT)).rejects.toThrow(/bad\.yaml:\n {2}orders\.0\.revision/);
  });

  it('refuses a plant where one operation runs in two work centers', async () => {
    const config = await plant();
    const [first, ...rest] = config.plant.areas;
    if (first === undefined) throw new Error('no area');
    const split: PlantConfig = {
      ...config,
      plant: {
        ...config.plant,
        areas: [
          first,
          ...rest,
          {
            id: 'extra',
            name: 'Extra',
            workCenters: [
              {
                id: 'cell-x',
                name: 'Cell X',
                equipment: [
                  {
                    id: 'cnc-09',
                    name: 'CNC 9',
                    operation: 'OP10',
                    interface: 'opcua',
                    requiresOperator: false,
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(() => masterDataFrom(split)).toThrow('OP10 runs in two work centers (cell-m1, cell-x)');
  });

  it('reports an invalid plant configuration', async () => {
    await expect(loadDataset(DATASET, join(REPO, 'config/erp'))).rejects.toThrow(
      /^plant configuration:/,
    );
  });
});
