/** Test support for the equipment module: UNS messages as the gateway sends them, and databases. */
import { resolve } from 'node:path';
import {
  alarmTopic,
  cycleTopic,
  stateTopic,
  telemetryTopic,
  type EquipmentPath,
  type MachineState,
  type UnsMessage,
} from '@shopfloor/contracts';
import { sql, type Kysely } from 'kysely';
import { createDatabase, type Database } from '../../db/database.ts';
import { migrate } from '../../db/migrate.ts';

export const MIGRATIONS = resolve(import.meta.dirname, '../../../../../db/migrations');
export const PLANT_CONFIG = resolve(import.meta.dirname, '../../../../../config/plant');
export const GW_EPOCH = 1_760_100_000;

export interface Delivery {
  readonly topic: string;
  readonly payload: string;
}

const iso = (at: number): string => new Date(at).toISOString();

/** Builds the UNS messages of a gateway: device facts with the device's seq, topic counters. */
export class UnsFeed {
  readonly #paths: ReadonlyMap<string, EquipmentPath>;
  readonly #counters = new Map<string, number>();

  constructor(paths: ReadonlyMap<string, EquipmentPath>) {
    this.#paths = paths;
  }

  path(equipment: string): EquipmentPath {
    return this.#paths.get(equipment) ?? { area: 'machining', workCenter: 'cell-t', equipment };
  }

  #common(equipment: string, epoch: number, seq: number, at: number) {
    return {
      epoch,
      seq,
      sourceTime: iso(at),
      receivedAt: '2026-10-15T10:00:00.000Z',
      quality: 'good' as const,
      source: {
        id: equipment,
        protocol: equipment.startsWith('wsh') ? ('modbus' as const) : ('opcua' as const),
      },
    };
  }

  #topicSeq(topic: string): number {
    const next = (this.#counters.get(topic) ?? 0) + 1;
    this.#counters.set(topic, next);
    return next;
  }

  #deliver(topic: string, message: UnsMessage): Delivery {
    return { topic, payload: JSON.stringify(message) };
  }

  state(
    equipment: string,
    epoch: number,
    seq: number,
    at: number,
    state: MachineState,
    cause: string | null = null,
  ): Delivery {
    return this.#deliver(stateTopic(this.path(equipment)), {
      schema: 'uns.state.current/1',
      kind: 'event',
      scope: 'device',
      ...this.#common(equipment, epoch, seq, at),
      value: { state, cause },
    });
  }

  /** A snapshot read after a (re)connect: gateway counter, the device epoch it was read in. */
  snapshot(equipment: string, deviceEpoch: number, at: number, state: MachineState): Delivery {
    const topic = stateTopic(this.path(equipment));
    return this.#deliver(topic, {
      schema: 'uns.state.current/1',
      kind: 'snapshot',
      scope: 'topic',
      deviceEpoch,
      ...this.#common(equipment, GW_EPOCH, this.#topicSeq(topic), at),
      value: { state, cause: null },
    });
  }

  cycle(
    equipment: string,
    epoch: number,
    seq: number,
    at: number,
    value: {
      readonly product: string;
      readonly partId: number;
      readonly serial: string;
      readonly result: 'good' | 'scrap' | 'rework';
      readonly reason?: string | null;
      readonly measurement?: {
        readonly characteristic: string;
        readonly value: number;
        readonly unit: string;
        readonly upperLimit: number;
      } | null;
    } = { product: 'VB-100', partId: seq, serial: `S-${String(seq)}`, result: 'good' },
  ): Delivery {
    return this.#deliver(cycleTopic(this.path(equipment)), {
      schema: 'uns.events.cycle-complete/1',
      scope: 'device',
      ...this.#common(equipment, epoch, seq, at),
      value: {
        product: value.product,
        partId: value.partId,
        serial: value.serial,
        result: value.result,
        reason: value.reason ?? null,
        measurement: value.measurement ?? null,
      },
    });
  }

  alarm(
    equipment: string,
    epoch: number,
    seq: number,
    at: number,
    code: string,
    transition: 'active' | 'cleared',
    severity: number,
  ): Delivery {
    return this.#deliver(alarmTopic(this.path(equipment), code.toLowerCase()), {
      schema: 'uns.alarms/1',
      scope: 'device',
      ...this.#common(equipment, epoch, seq, at),
      value: { code, transition, severity },
    });
  }

  /**
   * A telemetry sample; with `deviceEpoch` (contract 1.1) it is a watermark of that run (WSH-01's
   * telemetry carries the simulator's clock, register `simTime`).
   */
  telemetry(
    equipment: string,
    at: number,
    deviceEpoch?: number,
    name = 'bath-temperature',
    unit = '°C',
    value = 60,
  ): Delivery {
    const topic = telemetryTopic(this.path(equipment), name);
    return this.#deliver(topic, {
      schema: 'uns.telemetry/1',
      scope: 'topic',
      ...this.#common(equipment, GW_EPOCH, this.#topicSeq(topic), at),
      ...(deviceEpoch === undefined ? {} : { deviceEpoch }),
      unit,
      value,
    });
  }
}

let databases = 0;

/** A fresh, migrated database on the test server. */
export async function freshDatabase(serverUrl: string, prefix: string): Promise<Kysely<Database>> {
  databases++;
  const name = `${prefix}_${String(databases)}`;
  const admin = createDatabase(serverUrl, 1);
  await sql.raw(`CREATE DATABASE ${name}`).execute(admin);
  await admin.destroy();
  const db = createDatabase(serverUrl.replace(/\/shopfloor$/, `/${name}`), 4);
  await migrate(db, MIGRATIONS);
  return db;
}

/** Every stored piece, without the wall-clock column, in key order. */
export async function storedPieces(db: Kysely<Database>) {
  return db
    .selectFrom('equipment.equipment_state_interval')
    .select([
      'equipment',
      'epoch',
      'start_time',
      'end_time',
      'state',
      'cause',
      'hour',
      'shift_key',
      'provisional',
      'interval_start',
      'start_seq',
    ])
    .orderBy('equipment')
    .orderBy('epoch')
    .orderBy('start_time')
    .execute();
}

/** A small deterministic random generator (mulberry32) for shuffles. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}
