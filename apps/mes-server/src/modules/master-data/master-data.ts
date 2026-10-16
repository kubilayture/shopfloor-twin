import { parentReason, type PlantConfig } from '@shopfloor/plant-config';
import type { ShiftPattern } from '@shopfloor/shift-calendar';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../db/database.ts';

/** The plant's single shift pattern (Phase 4: one site, one pattern). */
export const SHIFT_PATTERN_ID = 'default';

export interface EquipmentInfo {
  readonly id: string;
  readonly name: string;
  readonly operation: string;
  readonly interface: 'opcua' | 'modbus';
  readonly position: number;
  readonly site: { readonly id: string; readonly name: string };
  readonly area: { readonly id: string; readonly name: string };
  readonly workCenter: { readonly id: string; readonly name: string };
}

export interface SiteInfo {
  readonly id: string;
  readonly name: string;
  readonly enterprise: { readonly id: string; readonly name: string };
}

/** A downtime reason (#119): its id is its path in the tree, `parent` the path above it. */
export interface ReasonCode {
  readonly id: string;
  readonly parent: string | null;
  readonly name: string;
  /** False once the configuration no longer lists it. */
  readonly active: boolean;
}

/** An alarm point's definition (#141, ADR-0024), from config/plant/alarms.yaml. */
export interface AlarmDefinition {
  readonly equipment: string;
  readonly code: string;
  readonly priority: 'high' | 'medium' | 'low';
  readonly text: string;
  readonly consequence: string | null;
  readonly response: string | null;
  /** False once the configuration no longer lists it. */
  readonly active: boolean;
}

/** An operator position (#141): the work centers whose alarms one operator handles. */
export interface AlarmPosition {
  readonly id: string;
  readonly name: string;
  /** In line order. */
  readonly workCenters: readonly string[];
  /** The equipment of those work centers, in line order. */
  readonly equipment: readonly string[];
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
      // The reason tree (#119): parents come first in reasons.yaml, so each row's parent exists.
      // Reasons the configuration no longer lists stay, inactive: records may name them.
      const reasons = config.reasons.reasons;
      await trx
        .updateTable('master_data.reason_code')
        .set({ active: false })
        .where(
          'id',
          'not in',
          reasons.map((reason) => reason.id),
        )
        .execute();
      for (const [position, reason] of reasons.entries()) {
        await trx
          .insertInto('master_data.reason_code')
          .values({
            id: reason.id,
            parent_id: parentReason(reason.id),
            name: reason.name,
            position,
            active: true,
          })
          .onConflict((c) =>
            c.column('id').doUpdateSet((eb) => ({
              parent_id: eb.ref('excluded.parent_id'),
              name: eb.ref('excluded.name'),
              position: eb.ref('excluded.position'),
              active: true,
            })),
          )
          .execute();
      }
      await seedAlarms(trx, config);
    });
  }

  /**
   * Alarm definitions (#141), in configuration order; those the configuration no longer lists only
   * with `inactive`.
   */
  async alarmDefinitions(
    options: { readonly inactive?: boolean } = {},
  ): Promise<AlarmDefinition[]> {
    let query = this.#db.selectFrom('master_data.alarm_definition').selectAll();
    if (options.inactive !== true) query = query.where('active', '=', true);
    const rows = await query
      .orderBy('active', 'desc')
      .orderBy('position')
      .orderBy('equipment_id')
      .orderBy('code')
      .execute();
    return rows.map((row) => ({
      equipment: row.equipment_id,
      code: row.code,
      priority: row.priority,
      text: row.text,
      consequence: row.consequence,
      response: row.response,
      active: row.active,
    }));
  }

  /** The active operator positions (#141), in configuration order, with their work centers. */
  async alarmPositions(): Promise<AlarmPosition[]> {
    const positions = await this.#db
      .selectFrom('master_data.alarm_position')
      .selectAll()
      .where('active', '=', true)
      .orderBy('position')
      .execute();
    const members = await this.#db
      .selectFrom('master_data.alarm_position_work_center as p')
      .innerJoin('master_data.equipment as e', 'e.work_center_id', 'p.work_center_id')
      .select(['p.position_id', 'p.work_center_id', 'e.id as equipment_id'])
      .orderBy('e.position')
      .execute();
    return positions.map((position) => {
      const own = members.filter((m) => m.position_id === position.id);
      return {
        id: position.id,
        name: position.name,
        workCenters: [...new Set(own.map((m) => m.work_center_id))],
        equipment: own.map((m) => m.equipment_id),
      };
    });
  }

  /**
   * The downtime reason tree (#119), in configuration order (a parent before its children); the
   * reasons the configuration no longer lists only with `inactive`.
   */
  async reasonCodes(options: { readonly inactive?: boolean } = {}): Promise<ReasonCode[]> {
    let query = this.#db.selectFrom('master_data.reason_code').selectAll();
    if (options.inactive !== true) query = query.where('active', '=', true);
    const rows = await query.orderBy('active', 'desc').orderBy('position').orderBy('id').execute();
    return rows.map((row) => ({
      id: row.id,
      parent: row.parent_id,
      name: row.name,
      active: row.active,
    }));
  }

  /** Every piece of equipment with its place in the hierarchy, in line order. */
  async equipment(): Promise<EquipmentInfo[]> {
    const rows = await this.#db
      .selectFrom('master_data.equipment as e')
      .innerJoin('master_data.work_center as w', 'w.id', 'e.work_center_id')
      .innerJoin('master_data.area as a', 'a.id', 'w.area_id')
      .innerJoin('master_data.site as s', 's.id', 'a.site_id')
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
        's.id as site_id',
        's.name as site_name',
      ])
      .orderBy('e.position')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      operation: r.operation,
      interface: r.interface,
      position: r.position,
      site: { id: r.site_id, name: r.site_name },
      area: { id: r.area_id, name: r.area_name },
      workCenter: { id: r.work_center_id, name: r.work_center_name },
    }));
  }

  /** The plant's site (Phase 4: one), or undefined before the seed. */
  async site(): Promise<SiteInfo | undefined> {
    const row = await this.#db
      .selectFrom('master_data.site')
      .selectAll()
      .orderBy('id')
      .executeTakeFirst();
    return (
      row && {
        id: row.id,
        name: row.name,
        enterprise: { id: row.enterprise_id, name: row.enterprise_name },
      }
    );
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

/**
 * Operator positions and alarm definitions from alarms.yaml (#141), inside the seed's transaction.
 * Positions and definitions the configuration drops stay, inactive; the work-center mapping is
 * rewritten, so a work center belongs to the position the configuration names now.
 */
async function seedAlarms(trx: Transaction<Database>, config: PlantConfig): Promise<void> {
  const { positions, definitions } = config.alarms;
  await trx.deleteFrom('master_data.alarm_position_work_center').execute();
  await trx
    .updateTable('master_data.alarm_position')
    .set({ active: false })
    .where(
      'id',
      'not in',
      positions.map((p) => p.id),
    )
    .execute();
  for (const [position, item] of positions.entries()) {
    await trx
      .insertInto('master_data.alarm_position')
      .values({ id: item.id, name: item.name, position, active: true })
      .onConflict((c) =>
        c.column('id').doUpdateSet((eb) => ({
          name: eb.ref('excluded.name'),
          position: eb.ref('excluded.position'),
          active: true,
        })),
      )
      .execute();
    await trx
      .insertInto('master_data.alarm_position_work_center')
      .values(
        item.workCenters.map((workCenter) => ({
          work_center_id: workCenter,
          position_id: item.id,
        })),
      )
      .execute();
  }
  await trx.updateTable('master_data.alarm_definition').set({ active: false }).execute();
  for (const [position, item] of definitions.entries()) {
    await trx
      .insertInto('master_data.alarm_definition')
      .values({
        equipment_id: item.equipment,
        code: item.code,
        priority: item.priority,
        text: item.text,
        consequence: item.consequence ?? null,
        response: item.response ?? null,
        position,
        active: true,
      })
      .onConflict((c) =>
        c.columns(['equipment_id', 'code']).doUpdateSet((eb) => ({
          priority: eb.ref('excluded.priority'),
          text: eb.ref('excluded.text'),
          consequence: eb.ref('excluded.consequence'),
          response: eb.ref('excluded.response'),
          position: eb.ref('excluded.position'),
          active: true,
        })),
      )
      .execute();
  }
}
