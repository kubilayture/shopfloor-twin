import { resolve } from 'node:path';
import { formatIssues, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { shiftKeyAt } from '@shopfloor/shift-calendar';
import { sql, type Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../db/database.ts';
import { migrate } from '../../db/migrate.ts';
import { startDatabase } from '../../testing.ts';
import { MasterData } from './index.ts';

let container: StartedTestContainer;
let db: Kysely<Database>;
let config: PlantConfig;

beforeAll(async () => {
  const started = await startDatabase();
  container = started.container;
  db = createDatabase(started.url, 3);
  await migrate(db, resolve(import.meta.dirname, '../../../../../db/migrations'));
  const loaded = await loadPlantConfig(resolve(import.meta.dirname, '../../../../../config/plant'));
  if (!loaded.ok) throw new Error(formatIssues(loaded.issues));
  config = loaded.config;
}, 180_000);

afterAll(async () => {
  await db.destroy();
  await container.stop();
});

const counts = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    await Promise.all(
      ['site', 'area', 'work_center', 'equipment', 'product', 'shift_pattern'].map(
        async (table) => {
          const result = await sql<{
            n: string;
          }>`SELECT count(*) AS n FROM ${sql.table(`master_data.${table}`)}`.execute(db);
          return [table, Number(result.rows[0]?.n)] as const;
        },
      ),
    ),
  );

describe('master-data (#94)', () => {
  it('seeds the hierarchy, products and shift pattern from config/plant, idempotently', async () => {
    const masterData = new MasterData(db);
    await masterData.seed(config);
    const first = await counts();
    expect(first).toEqual({
      site: 1,
      area: 2,
      work_center: 2,
      equipment: 6,
      product: 2,
      shift_pattern: 1,
    });
    await masterData.seed(config);
    expect(await counts()).toEqual(first);
  });

  it('lists equipment in line order with its place in the ISA-95 hierarchy', async () => {
    const equipment = await new MasterData(db).equipment();
    expect(equipment.map((e) => e.id)).toEqual([
      'cnc-01',
      'cnc-02',
      'wsh-01',
      'asm-01',
      'lkt-01',
      'pck-01',
    ]);
    expect(equipment[2]).toMatchObject({
      id: 'wsh-01',
      operation: 'OP20',
      interface: 'modbus',
      site: { id: 'gebze', name: 'Gebze' },
      area: { id: 'machining', name: 'Machining' },
      workCenter: { id: 'cell-m1', name: 'Cell M1' },
    });
    expect(await new MasterData(db).site()).toEqual({
      id: 'gebze',
      name: 'Gebze',
      enterprise: { id: 'orbis', name: 'Orbis Components' },
    });
  });

  it('returns the shift pattern so that the MES cuts shifts exactly as the simulator', async () => {
    const pattern = await new MasterData(db).shiftPattern();
    expect(pattern).toEqual({
      timeZone: config.shifts.timeZone,
      workdays: config.shifts.workdays,
      shifts: config.shifts.shifts,
    });
    const tuesdayTen = Date.UTC(2026, 9, 13, 7);
    expect(shiftKeyAt(pattern, tuesdayTen)).toBe(shiftKeyAt(config.shifts, tuesdayTen));
  });

  it('follows a changed configuration on the next seed', async () => {
    const renamed = structuredClone(config);
    const cnc = renamed.plant.areas[0]?.workCenters[0]?.equipment[0];
    if (!cnc) throw new Error('no cnc');
    cnc.name = 'Horizontal machining centre 1 (retrofit)';
    await new MasterData(db).seed(renamed);
    expect((await new MasterData(db).equipment())[0]?.name).toBe(
      'Horizontal machining centre 1 (retrofit)',
    );
    await new MasterData(db).seed(config);
  });

  it('seeds the reason tree; a reason the configuration drops stays, inactive (#119)', async () => {
    const masterData = new MasterData(db);
    const reasons = await masterData.reasonCodes();
    expect(reasons.map((r) => r.id)).toEqual(config.reasons.reasons.map((r) => r.id));
    expect(reasons.slice(0, 2)).toEqual([
      { id: 'BREAKDOWN', parent: null, name: 'Breakdown', active: true },
      {
        id: 'BREAKDOWN/SPINDLE-OVERLOAD',
        parent: 'BREAKDOWN',
        name: 'Spindle overload',
        active: true,
      },
    ]);
    const fewer = structuredClone(config);
    fewer.reasons.reasons = fewer.reasons.reasons.filter((r) => r.id !== 'MINOR-STOP/LABEL-OUT');
    await masterData.seed(fewer);
    expect((await masterData.reasonCodes()).map((r) => r.id)).not.toContain('MINOR-STOP/LABEL-OUT');
    expect((await masterData.reasonCodes({ inactive: true })).at(-1)).toEqual({
      id: 'MINOR-STOP/LABEL-OUT',
      parent: 'MINOR-STOP',
      name: 'Labels out',
      active: false,
    });
    await masterData.seed(config);
    expect(await masterData.reasonCodes()).toEqual(reasons);
    // The table refuses a parent that is not the id's path prefix.
    await expect(
      sql`INSERT INTO master_data.reason_code (id, parent_id, name, position)
          VALUES ('SETUP/X', 'BREAKDOWN', 'Wrong parent', 99)`.execute(db),
    ).rejects.toThrow(/check constraint/);
  });

  it('reports a missing seed clearly', async () => {
    await sql`DELETE FROM master_data.shift_pattern`.execute(db);
    await expect(new MasterData(db).shiftPattern()).rejects.toThrow(/not seeded/);
    await new MasterData(db).seed(config);
  });
});
