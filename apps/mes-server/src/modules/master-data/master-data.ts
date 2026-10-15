import type { PlantConfig } from '@shopfloor/plant-config';
import type { ShiftPattern } from '@shopfloor/shift-calendar';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/database.ts';

/** The plant's single shift pattern (Phase 4: one site, one pattern). */
export const SHIFT_PATTERN_ID = 'default';

export interface EquipmentInfo {
  readonly id: string;
  readonly name: string;
  readonly operation: string;
  readonly interface: 'opcua' | 'modbus';
  readonly position: number;
  readonly area: { readonly id: string; readonly name: string };
  readonly workCenter: { readonly id: string; readonly name: string };
}

/** master-data's interface for the other modules (plan section 7). */
export class MasterData {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  /**
   * Inserts or updates everything from `config/plant` in one transaction. Idempotent: seeding the
   * same configuration twice changes nothing. Entries removed from the configuration stay (the
   * data recorded for them must keep its references).
   */
  async seed(config: PlantConfig): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await trx
        .insertInto('master_data.site')
        .values({
          id: config.plant.site.id,
          name: config.plant.site.name,
          enterprise_id: config.plant.enterprise.id,
          enterprise_name: config.plant.enterprise.name,
        })
        .onConflict((c) =>
          c.column('id').doUpdateSet((eb) => ({
            name: eb.ref('excluded.name'),
            enterprise_id: eb.ref('excluded.enterprise_id'),
            enterprise_name: eb.ref('excluded.enterprise_name'),
          })),
        )
        .execute();
      let position = 0;
      for (const area of config.plant.areas) {
        await trx
          .insertInto('master_data.area')
          .values({ id: area.id, site_id: config.plant.site.id, name: area.name })
          .onConflict((c) =>
            c.column('id').doUpdateSet((eb) => ({
              site_id: eb.ref('excluded.site_id'),
              name: eb.ref('excluded.name'),
            })),
          )
          .execute();
        for (const workCenter of area.workCenters) {
          await trx
            .insertInto('master_data.work_center')
            .values({ id: workCenter.id, area_id: area.id, name: workCenter.name })
            .onConflict((c) =>
              c.column('id').doUpdateSet((eb) => ({
                area_id: eb.ref('excluded.area_id'),
                name: eb.ref('excluded.name'),
              })),
            )
            .execute();
          for (const item of workCenter.equipment) {
            await trx
              .insertInto('master_data.equipment')
              .values({
                id: item.id,
                work_center_id: workCenter.id,
                name: item.name,
                operation: item.operation,
                interface: item.interface,
                position: position++,
              })
              .onConflict((c) =>
                c.column('id').doUpdateSet((eb) => ({
                  work_center_id: eb.ref('excluded.work_center_id'),
                  name: eb.ref('excluded.name'),
                  operation: eb.ref('excluded.operation'),
                  interface: eb.ref('excluded.interface'),
                  position: eb.ref('excluded.position'),
                })),
              )
              .execute();
          }
        }
      }
      for (const product of config.products.products) {
        await trx
          .insertInto('master_data.product')
          .values({
            id: product.id,
            name: product.name,
            ideal_cycle_seconds: JSON.stringify(product.idealCycleSeconds),
          })
          .onConflict((c) =>
            c.column('id').doUpdateSet((eb) => ({
              name: eb.ref('excluded.name'),
              ideal_cycle_seconds: eb.ref('excluded.ideal_cycle_seconds'),
            })),
          )
          .execute();
      }
      await trx
        .insertInto('master_data.shift_pattern')
        .values({
          id: SHIFT_PATTERN_ID,
          time_zone: config.shifts.timeZone,
          workdays: [...config.shifts.workdays],
          shifts: JSON.stringify(config.shifts.shifts),
        })
        .onConflict((c) =>
          c.column('id').doUpdateSet((eb) => ({
            time_zone: eb.ref('excluded.time_zone'),
            workdays: eb.ref('excluded.workdays'),
            shifts: eb.ref('excluded.shifts'),
          })),
        )
        .execute();
    });
  }

  /** Every piece of equipment with its place in the hierarchy, in line order. */
  async equipment(): Promise<EquipmentInfo[]> {
    const rows = await this.#db
      .selectFrom('master_data.equipment as e')
      .innerJoin('master_data.work_center as w', 'w.id', 'e.work_center_id')
      .innerJoin('master_data.area as a', 'a.id', 'w.area_id')
      .select([
        'e.id',
        'e.name',
        'e.operation',
        'e.interface',
        'e.position',
        'w.id as work_center_id',
        'w.name as work_center_name',
        'a.id as area_id',
        'a.name as area_name',
      ])
      .orderBy('e.position')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      operation: r.operation,
      interface: r.interface,
      position: r.position,
      area: { id: r.area_id, name: r.area_name },
      workCenter: { id: r.work_center_id, name: r.work_center_name },
    }));
  }

  async shiftPattern(): Promise<ShiftPattern> {
    const row = await this.#db
      .selectFrom('master_data.shift_pattern')
      .selectAll()
      .where('id', '=', SHIFT_PATTERN_ID)
      .executeTakeFirstOrThrow(() => new Error('no shift pattern: master data not seeded'));
    return { timeZone: row.time_zone, workdays: row.workdays, shifts: row.shifts };
  }
}
