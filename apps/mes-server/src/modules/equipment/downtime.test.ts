import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/database.ts';
import { startDatabase } from '../../testing.ts';
import { Ingest } from '../ingest/index.ts';
import { MasterData } from '../master-data/index.ts';
import { deriveRecords, type DowntimeRules } from './downtime.ts';
import { Equipment, downtimeRules, type EquipmentOptions } from './index.ts';
import { cutPieces } from './pieces.ts';
import {
  PLANT_CONFIG,
  UnsFeed,
  freshDatabase,
  random,
  shuffle,
  type Delivery,
} from './test-support.ts';

const E1 = 1_760_000_000;
const E2 = 1_760_003_600;
const SHIFT_A = '2026-10-12/A'; // 03:00 to 11:00 UTC
const SHIFT_B = '2026-10-12/B'; // 11:00 to 19:00 UTC
const MIN = 60_000;

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
let rules: DowntimeRules;
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
  rules = downtimeRules(plant);
}, 180_000);

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

afterAll(async () => {
  await container.stop();
});

/** Monday 2026-10-12 (or another October day) at a UTC time; Istanbul is UTC+3. */
const at = (time: string, day = 12): number =>
  Date.parse(
    `2026-10-${String(day).padStart(2, '0')}T${time.length === 5 ? `${time}:00` : time}.000Z`,
  );

const hhmm = (date: Date | null): string | null => date?.toISOString().slice(11, 19) ?? null;

const feed = new UnsFeed(new Map());

async function setup(options: Partial<EquipmentOptions> = {}) {
  const db = await freshDatabase(serverUrl, 'downtime');
  cleanup.push(() => db.destroy());
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const shiftPattern = await masterData.shiftPattern();
  const ingest = new Ingest({ db, url: 'mqtt://127.0.0.1:1', username: 'mes', password: 'u' });
  const start = async (more: Partial<EquipmentOptions> = {}): Promise<Equipment> => {
    const equipment = new Equipment({
      db,
      source: ingest,
      shiftPattern,
      provisionalStepMs: 0,
      downtime: rules,
      ...options,
      ...more,
    });
    await equipment.start();
    cleanup.push(() => equipment.stop());
    return equipment;
  };
  const send = async (...deliveries: Delivery[]): Promise<void> => {
    for (const d of deliveries) await ingest.deliver(d.topic, d.payload);
  };
  return { db, masterData, start, send };
}

/** Stored records of one equipment, compactly, in key order. */
async function records(db: Kysely<Database>, equipment: string) {
  const rows = await db
    .selectFrom('equipment.downtime_record')
    .selectAll()
    .where('equipment', '=', equipment)
    .orderBy('epoch')
    .orderBy('start_time')
    .execute();
  return rows.map((row) => [
    row.epoch === E2 ? 'E2' : 'E1',
    hhmm(row.start_time),
    hhmm(row.end_time),
    row.state,
    row.shift_key,
    row.auto_reason,
    row.provisional ? 'provisional' : 'final',
  ]);
}

/** Every stored record without the wall-clock column, for comparing two databases. */
const allRecords = (db: Kysely<Database>) =>
  db
    .selectFrom('equipment.downtime_record')
    .select(['equipment', 'epoch', 'start_time', 'end_time', 'interval_start', 'shift_key'])
    .select(['state', 'cause', 'auto_reason', 'provisional'])
    .orderBy('equipment')
    .orderBy('epoch')
    .orderBy('start_time')
    .execute();

describe('deriving downtime records (#119)', () => {
  const derive = (
    points: { at: number; state: string; cause?: string }[],
    end: number,
    open = false,
  ) => {
    const pieces = cutPieces(
      points.map((p, i) => ({ at: p.at, state: p.state, cause: p.cause ?? null, seq: i + 1 })),
      end,
      plant.shifts,
      Infinity,
    );
    return deriveRecords(pieces, rules, open ? points.at(-1)?.at : undefined).map((r) => [
      hhmm(new Date(r.from)),
      r.to === null ? null : hhmm(new Date(r.to)),
      r.state,
      r.shiftKey,
      r.loss,
      r.reason,
      r.provisional,
    ]);
  };

  it('makes one record per shift bucket: a Down across the shift end gets two keys', () => {
    expect(
      derive(
        [
          { at: at('10:30'), state: 'Down', cause: 'SPINDLE-OVERLOAD' },
          { at: at('12:15'), state: 'Running' },
        ],
        at('12:30'),
      ),
    ).toEqual([
      // Keyed by the later of the interval's start and the bucket's start: no collision.
      ['10:30:00', '11:00:00', 'Down', SHIFT_A, 'own', 'BREAKDOWN/SPINDLE-OVERLOAD', false],
      ['11:00:00', '12:15:00', 'Down', SHIFT_B, 'own', 'BREAKDOWN/SPINDLE-OVERLOAD', false],
    ]);
  });

  it('promotes a Stopped interval at the threshold; micro-stops and planned time make none', () => {
    const stop = (ms: number) =>
      derive(
        [
          { at: at('09:00'), state: 'Stopped', cause: 'CHIP-JAM' },
          { at: at('09:00') + ms, state: 'Running' },
        ],
        at('10:00'),
      );
    expect(stop(2 * MIN - 1)).toEqual([]);
    expect(stop(2 * MIN)).toEqual([
      ['09:00:00', '09:02:00', 'Stopped', SHIFT_A, 'own', 'MINOR-STOP/CHIP-JAM', false],
    ]);
    expect(
      derive(
        [
          { at: at('07:00'), state: 'PlannedStop', cause: 'BREAK' },
          { at: at('07:30'), state: 'Maintenance', cause: 'CALIBRATION' },
          { at: at('08:00'), state: 'Starved' },
          { at: at('08:10'), state: 'Blocked' },
          { at: at('08:20'), state: 'Running' },
        ],
        at('09:00'),
      ),
    ).toEqual([
      ['08:00:00', '08:10:00', 'Starved', SHIFT_A, 'external', 'STARVED', false],
      ['08:10:00', '08:20:00', 'Blocked', SHIFT_A, 'external', 'BLOCKED', false],
    ]);
  });

  it('leaves the open record without an end, and the no-shift bucket without records', () => {
    // An open stop counts from the threshold on, over its length so far.
    const open = (minutes: number) =>
      derive(
        [{ at: at('09:00'), state: 'Stopped', cause: 'LABEL-OUT' }],
        at('09:00') + minutes * MIN,
        true,
      );
    expect(open(1)).toEqual([]);
    expect(open(3)).toEqual([
      ['09:00:00', null, 'Stopped', SHIFT_A, 'own', 'MINOR-STOP/LABEL-OUT', true],
    ]);
    // Friday's night shift C ends on Saturday 06:00 local (03:00 UTC); the weekend is no-shift.
    expect(
      derive(
        [{ at: at('02:00', 17), state: 'Down', cause: 'HEATER-FAULT' }],
        at('04:00', 17),
        true,
      ),
    ).toEqual([
      ['02:00:00', '03:00:00', 'Down', '2026-10-16/C', 'own', 'BREAKDOWN/HEATER-FAULT', false],
    ]);
    // A cause no rule knows stays UNCODED.
    expect(derive([{ at: at('09:00'), state: 'Down', cause: 'NEW-FAULT' }], at('09:30'))).toEqual([
      ['09:00:00', '09:30:00', 'Down', SHIFT_A, 'own', 'UNCODED', false],
    ]);
  });
});

describe('downtime records in the equipment module (#119)', () => {
  it('follows the intervals in order, across a shift end, and reads them back for #120', async () => {
    const { db, masterData, start, send } = await setup();
    const equipment = await start();
    await send(
      feed.state('cnc-a', E1, 1, at('10:00'), 'Running'),
      feed.state('cnc-a', E1, 2, at('10:30'), 'Down', 'SPINDLE-OVERLOAD'),
      feed.cycle('cnc-b', E1, 1, at('11:15')),
    );
    // Open: the record in the last stored bucket has no end.
    expect(await records(db, 'cnc-a')).toEqual([
      ['E1', '10:30:00', '11:00:00', 'Down', SHIFT_A, 'BREAKDOWN/SPINDLE-OVERLOAD', 'provisional'],
      ['E1', '11:00:00', null, 'Down', SHIFT_B, 'BREAKDOWN/SPINDLE-OVERLOAD', 'provisional'],
    ]);
    await send(
      feed.state('cnc-a', E1, 3, at('11:20'), 'Idle', 'MYSTERY'),
      feed.state('cnc-a', E1, 4, at('11:40'), 'Running'),
    );
    expect(await records(db, 'cnc-a')).toEqual([
      ['E1', '10:30:00', '11:00:00', 'Down', SHIFT_A, 'BREAKDOWN/SPINDLE-OVERLOAD', 'final'],
      ['E1', '11:00:00', '11:20:00', 'Down', SHIFT_B, 'BREAKDOWN/SPINDLE-OVERLOAD', 'final'],
      ['E1', '11:20:00', '11:40:00', 'Idle', SHIFT_B, 'UNCODED', 'final'],
    ]);
    const read = await equipment.downtimeRecords({
      from: new Date(at('11:10')),
      to: new Date(at('12:00')),
      uncodedFirst: true,
    });
    expect(read.map((r) => [r.equipment, hhmm(r.start), r.autoReason, r.loss])).toEqual([
      ['cnc-a', '11:20:00', 'UNCODED', 'own'],
      ['cnc-a', '11:00:00', 'BREAKDOWN/SPINDLE-OVERLOAD', 'own'],
    ]);
    expect(read[1]).toMatchObject({
      epoch: E1,
      end: new Date(at('11:20')),
      intervalStart: new Date(at('10:30')),
      shiftKey: SHIFT_B,
      state: 'Down',
      cause: 'SPINDLE-OVERLOAD',
      provisional: false,
    });
    expect(
      await equipment.downtimeRecords({
        from: new Date(at('00:00')),
        to: new Date(at('23:00')),
        equipment: 'cnc-b',
      }),
    ).toEqual([]);
    expect(
      (await equipment.downtimeRecords({ from: new Date(0), to: new Date(at('23:00')), limit: 1 }))
        .length,
    ).toBe(1);
    // The reason tree, for the coding screen.
    const reasons = await masterData.reasonCodes();
    expect(reasons.find((r) => r.id === 'BREAKDOWN/SPINDLE-OVERLOAD')).toEqual({
      id: 'BREAKDOWN/SPINDLE-OVERLOAD',
      parent: 'BREAKDOWN',
      name: 'Spindle overload',
      active: true,
    });
  });

  it('reads a record that started most of a shift before the range', async () => {
    const { start, send } = await setup();
    const equipment = await start();
    // Down for all of shift B but ten minutes (11:00 to 18:50 UTC), read from 18:40 on.
    await send(
      feed.state('cnc-a', E1, 1, at('11:00'), 'Down', 'SPINDLE-OVERLOAD'),
      feed.state('cnc-a', E1, 2, at('18:50'), 'Running'),
    );
    const read = await equipment.downtimeRecords({
      from: new Date(at('18:40')),
      to: new Date(at('19:00')),
      equipment: 'cnc-a',
    });
    expect(read.map((r) => [hhmm(r.start), hhmm(r.end), r.shiftKey])).toEqual([
      ['11:00:00', '18:50:00', SHIFT_B],
    ]);
    expect(
      await equipment.downtimeRecords({
        from: new Date(at('18:50')),
        to: new Date(at('19:00')),
        uncodedFirst: true,
      }),
    ).toEqual([]);
  });

  it('promotes an open Stopped interval to a record once it reaches the threshold', async () => {
    const { db, start, send } = await setup();
    await start();
    await send(feed.state('cnc-a', E1, 1, at('09:00'), 'Stopped', 'CHIP-JAM'));
    await send(feed.cycle('cnc-b', E1, 1, at('09:01:59')));
    expect(await records(db, 'cnc-a')).toEqual([]); // a micro-stop so far
    await send(feed.cycle('cnc-b', E1, 2, at('09:02')));
    expect(await records(db, 'cnc-a')).toEqual([
      ['E1', '09:00:00', null, 'Stopped', SHIFT_A, 'MINOR-STOP/CHIP-JAM', 'provisional'],
    ]);
    await send(feed.state('cnc-a', E1, 2, at('09:05'), 'Running'));
    expect(await records(db, 'cnc-a')).toEqual([
      ['E1', '09:00:00', '09:05:00', 'Stopped', SHIFT_A, 'MINOR-STOP/CHIP-JAM', 'final'],
    ]);
    // A 4-minute stop is a record; a late fact splits it below the threshold, and the record goes.
    await send(feed.state('cnc-a', E1, 3, at('09:06'), 'Stopped', 'DOOR-INTERLOCK'));
    await send(feed.state('cnc-a', E1, 5, at('09:10'), 'Running'));
    expect(await records(db, 'cnc-a')).toEqual([
      ['E1', '09:00:00', '09:05:00', 'Stopped', SHIFT_A, 'MINOR-STOP/CHIP-JAM', 'final'],
      [
        'E1',
        '09:06:00',
        '09:10:00',
        'Stopped',
        SHIFT_A,
        'MINOR-STOP/DOOR-INTERLOCK',
        'provisional',
      ],
    ]);
    await send(feed.state('cnc-a', E1, 4, at('09:06:30'), 'Running'));
    expect(await records(db, 'cnc-a')).toEqual([
      ['E1', '09:00:00', '09:05:00', 'Stopped', SHIFT_A, 'MINOR-STOP/CHIP-JAM', 'final'],
    ]);
  });

  it('is rebuilt with the intervals: late facts and shuffled delivery store the same records', async () => {
    const facts: Delivery[] = [];
    const states = ['Running', 'Down', 'Starved', 'Running', 'Setup', 'Blocked', 'Idle'] as const;
    const causes: Record<string, string | null> = {
      Down: 'PRESS-FAULT',
      Setup: 'TOOL-CHANGE',
      Idle: 'NO-OPERATOR',
    };
    for (let seq = 1; seq <= 60; seq++) {
      const state = states[seq % states.length] ?? 'Running';
      facts.push(
        feed.state('asm-x', E1, seq, at('09:00') + seq * 7 * MIN, state, causes[state] ?? null),
      );
    }
    const end = feed.cycle('cnc-b', E1, 1, at('17:00'));
    const inOrder = await setup();
    await inOrder.start();
    await inOrder.send(...facts, end);
    const reference = await allRecords(inOrder.db);
    expect(reference.length).toBeGreaterThan(30);
    // Records on both sides of the A/B handover at 11:00 UTC.
    expect(new Set(reference.map((r) => r.shift_key))).toEqual(new Set([SHIFT_A, SHIFT_B]));

    const shuffled = await setup();
    await shuffled.start();
    const next = random(119);
    await shuffled.send(...shuffle([...facts, ...facts.filter(() => next() < 0.2)], next), end);
    expect(await allRecords(shuffled.db)).toEqual(reference);
  });

  it('keeps records per epoch: a new epoch closes the old one’s open record, final', async () => {
    const { db, start, send } = await setup();
    await start();
    await send(
      feed.state('cnc-a', E1, 1, at('10:00'), 'Setup', 'CHANGEOVER VB-100→VB-200'),
      feed.cycle('cnc-b', E1, 1, at('10:20')),
    );
    expect(await records(db, 'cnc-a')).toEqual([
      ['E1', '10:00:00', null, 'Setup', SHIFT_A, 'SETUP/CHANGEOVER', 'provisional'],
    ]);
    // The new run starts at the same simulation time: its records have their own key space.
    await send(feed.state('cnc-a', E2, 1, at('10:00'), 'Starved', 'MATERIAL:BLANK-100'));
    await send(feed.state('cnc-a', E2, 2, at('10:10'), 'Running'));
    expect(await records(db, 'cnc-a')).toEqual([
      ['E1', '10:00:00', '10:20:00', 'Setup', SHIFT_A, 'SETUP/CHANGEOVER', 'final'],
      ['E2', '10:00:00', '10:10:00', 'Starved', SHIFT_A, 'MATERIAL', 'final'],
    ]);
  });

  it('holds records provisional until the machine’s own facts settle them (#113)', async () => {
    const { db, start, send } = await setup();
    await start();
    await send(
      feed.state('cnc-a', E1, 1, at('10:00'), 'Down', 'COOLANT-PRESSURE'),
      feed.state('cnc-a', E1, 3, at('10:40'), 'Idle', 'NO-OPERATOR'),
      feed.state('cnc-a', E1, 4, at('10:50'), 'Running'),
    );
    // Seq 2 is missing: nothing after the Down's start is final yet.
    expect(await records(db, 'cnc-a')).toEqual([
      ['E1', '10:00:00', '10:40:00', 'Down', SHIFT_A, 'BREAKDOWN/COOLANT-PRESSURE', 'provisional'],
      ['E1', '10:40:00', '10:50:00', 'Idle', SHIFT_A, 'ORGANISATION/NO-OPERATOR', 'provisional'],
    ]);
    // The late fact fills the gap: the Down splits, and everything up to seq 4 is final.
    await send(feed.state('cnc-a', E1, 2, at('10:25'), 'Down', null));
    expect(await records(db, 'cnc-a')).toEqual([
      ['E1', '10:00:00', '10:25:00', 'Down', SHIFT_A, 'BREAKDOWN/COOLANT-PRESSURE', 'final'],
      ['E1', '10:25:00', '10:40:00', 'Down', SHIFT_A, 'BREAKDOWN/UNSPECIFIED', 'final'],
      ['E1', '10:40:00', '10:50:00', 'Idle', SHIFT_A, 'ORGANISATION/NO-OPERATOR', 'final'],
    ]);
  });

  it('catches up after a restart: missing records, a changed threshold and changed rules', async () => {
    const { db, start, send } = await setup();
    const first = await start();
    await send(
      feed.state('cnc-a', E1, 1, at('09:00'), 'Stopped', 'CHIP-JAM'),
      feed.state('cnc-a', E1, 2, at('09:03'), 'Down', 'SPINDLE-OVERLOAD'),
      feed.state('cnc-a', E1, 3, at('09:30'), 'Running'),
      feed.cycle('cnc-a', E1, 4, at('09:40')),
    );
    const before = await records(db, 'cnc-a');
    expect(before).toEqual([
      ['E1', '09:00:00', '09:03:00', 'Stopped', SHIFT_A, 'MINOR-STOP/CHIP-JAM', 'final'],
      ['E1', '09:03:00', '09:30:00', 'Down', SHIFT_A, 'BREAKDOWN/SPINDLE-OVERLOAD', 'final'],
    ]);
    await first.stop();
    // Intervals stored before #119: no records, no threshold. Catch-up derives them.
    await db.deleteFrom('equipment.downtime_record').execute();
    await db
      .updateTable('equipment.interval_source')
      .set({ downtime_threshold_ms: null })
      .execute();
    const second = await start();
    expect(await records(db, 'cnc-a')).toEqual(before);
    await second.stop();
    // A higher threshold makes the 3-minute stop a micro-stop; new rules recode the breakdown.
    const third = await start({
      downtime: {
        microStopThresholdMs: 5 * MIN,
        classify: (state, cause) =>
          state === 'Down' ? 'BREAKDOWN/UNSPECIFIED' : rules.classify(state, cause),
      },
    });
    expect(await records(db, 'cnc-a')).toEqual([
      ['E1', '09:03:00', '09:30:00', 'Down', SHIFT_A, 'BREAKDOWN/UNSPECIFIED', 'final'],
    ]);
    await third.stop();
    // Rules alone changed back: the stored records are recoded without a recompute.
    await start({ downtime: { ...rules, microStopThresholdMs: 5 * MIN } });
    expect(await records(db, 'cnc-a')).toEqual([
      ['E1', '09:03:00', '09:30:00', 'Down', SHIFT_A, 'BREAKDOWN/SPINDLE-OVERLOAD', 'final'],
    ]);
  });

  it('derives the records of a long track in one transaction at a restart', async () => {
    const { db, start, send } = await setup();
    const first = await start();
    // 1,500 one-minute breakdowns from shift A on: more pieces and records than one statement takes.
    const facts: Delivery[] = [];
    for (let seq = 1; seq <= 3_000; seq++) {
      const down = seq % 2 === 1;
      facts.push(
        feed.state('cnc-a', E1, seq, at('03:00') + seq * MIN, down ? 'Down' : 'Running', null),
      );
    }
    await send(...facts);
    const reference = await allRecords(db);
    expect(reference.length).toBe(1_500);
    await first.stop();
    await db.deleteFrom('equipment.downtime_record').execute();
    await db
      .updateTable('equipment.interval_source')
      .set({ downtime_threshold_ms: null })
      .execute();
    await start();
    expect(await allRecords(db)).toEqual(reference);
  });
});
