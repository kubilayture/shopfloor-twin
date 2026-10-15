import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/database.ts';
import { startDatabase } from '../../testing.ts';
import { Ingest } from '../ingest/index.ts';
import { MasterData } from '../master-data/index.ts';
import { Equipment, type EquipmentChange, type EquipmentOptions } from './index.ts';
import {
  PLANT_CONFIG,
  UnsFeed,
  freshDatabase,
  random,
  shuffle,
  storedPieces,
  type Delivery,
} from './test-support.ts';

const E1 = 1_760_000_000;
const E2 = 1_760_003_600;

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
}, 180_000);

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

afterAll(async () => {
  await container.stop();
});

/** Monday 2026-10-12 (or another October day) at a UTC time; Istanbul is UTC+3. */
const at = (time: string, day = 12): number =>
  Date.parse(`2026-10-${String(day)}T${time.length === 5 ? `${time}:00` : time}.000Z`);

const feed = new UnsFeed(new Map());

async function setup(options: Partial<EquipmentOptions> = {}) {
  const db = await freshDatabase(serverUrl, 'equipment');
  cleanup.push(() => db.destroy());
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const shiftPattern = await masterData.shiftPattern();
  // Never started: deliveries go through `deliver`, the store path without a broker.
  const ingest = new Ingest({ db, url: 'mqtt://127.0.0.1:1', username: 'mes', password: 'unused' });
  const start = async (more: Partial<EquipmentOptions> = {}): Promise<Equipment> => {
    const equipment = new Equipment({
      db,
      source: ingest,
      shiftPattern,
      provisionalStepMs: 0,
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
  return { db, ingest, start, send };
}

const hhmm = (date: Date): string => date.toISOString().slice(11, 16);

/** Stored pieces of one equipment, compactly. */
async function pieces(db: Kysely<Database>, equipment: string) {
  const rows = await storedPieces(db);
  return rows
    .filter((row) => row.equipment === equipment)
    .map((row) => [
      row.epoch === E2 ? 'E2' : 'E1',
      hhmm(row.start_time),
      hhmm(row.end_time),
      row.state,
      row.shift_key,
      row.provisional ? 'provisional' : 'final',
      row.start_seq,
    ]);
}

describe('equipment state intervals (#96)', () => {
  it('closes a silent machine provisionally at hour and shift boundaries, by another device', async () => {
    const { db, start, send } = await setup();
    const equipment = await start();
    const changes: EquipmentChange[] = [];
    equipment.onChange((change) => changes.push(change));
    await send(feed.state('cnc-a', E1, 1, at('10:30'), 'Running'));
    expect(await pieces(db, 'cnc-a')).toEqual([]); // zero length so far
    await send(feed.cycle('cnc-b', E1, 1, at('10:45')));
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:30', '10:45', 'Running', '2026-10-12/A', 'provisional', 1],
    ]);
    // Telemetry (WSH-01's simulation clock) moves the watermark too: across 14:00 local, the
    // A/B handover and an hour at once.
    await send(feed.state('wsh-01', E1, 1, at('10:00'), 'Idle'));
    await send(feed.telemetry('wsh-01', at('11:20'), E1));
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:30', '11:00', 'Running', '2026-10-12/A', 'provisional', 1],
      ['E1', '11:00', '11:20', 'Running', '2026-10-12/B', 'provisional', 1],
    ]);
    await send(feed.cycle('cnc-b', E1, 2, at('12:05')));
    // The next fact replaces the provisional pieces with final ones.
    await send(feed.state('cnc-a', E1, 2, at('12:10'), 'Down', 'SPINDLE-FAULT'));
    await send(feed.cycle('cnc-b', E1, 3, at('12:15')));
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:30', '11:00', 'Running', '2026-10-12/A', 'final', 1],
      ['E1', '11:00', '12:00', 'Running', '2026-10-12/B', 'final', 1],
      ['E1', '12:00', '12:10', 'Running', '2026-10-12/B', 'final', 1],
      ['E1', '12:10', '12:15', 'Down', '2026-10-12/B', 'provisional', 2],
    ]);
    expect(equipment.currentState('cnc-a')).toMatchObject({
      epoch: E1,
      state: 'Down',
      cause: 'SPINDLE-FAULT',
      since: new Date(at('12:10')),
      seq: 2,
      until: new Date(at('12:15')),
    });
    expect(equipment.watermark(E1)).toEqual(new Date(at('12:15')));
    expect(equipment.currentStates().map((s) => s.equipment)).toEqual(['cnc-a', 'wsh-01']);
    expect(changes.some((c) => c.equipment === 'cnc-a' && c.current?.state === 'Down')).toBe(true);

    const range = await equipment.intervals('cnc-a', new Date(at('11:30')), new Date(at('12:12')));
    expect(range.map((r) => [hhmm(r.start), r.state])).toEqual([
      ['11:00', 'Running'],
      ['12:00', 'Running'],
      ['12:10', 'Down'],
    ]);
    expect(await equipment.shiftTotals('2026-10-12/B', { equipment: 'cnc-a' })).toEqual([
      { equipment: 'cnc-a', epoch: E1, state: 'Down', ms: 5 * 60_000, provisionalMs: 5 * 60_000 },
      { equipment: 'cnc-a', epoch: E1, state: 'Running', ms: 70 * 60_000, provisionalMs: 0 },
    ]);
  });

  it('stores the open interval in steps, at every boundary, and exactly on flush', async () => {
    const { db, start, send } = await setup();
    const equipment = await start({ provisionalStepMs: 60_000 });
    await send(feed.state('cnc-a', E1, 1, at('10:10'), 'Running'));
    await send(feed.cycle('cnc-b', E1, 1, at('10:20')));
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:10', '10:20', 'Running', '2026-10-12/A', 'provisional', 1],
    ]);
    await send(feed.cycle('cnc-b', E1, 2, at('10:20:30'))); // less than a step: not stored yet
    expect((await pieces(db, 'cnc-a'))[0]?.[2]).toBe('10:20');
    await send(feed.cycle('cnc-b', E1, 3, at('11:00:10'))); // past the hour and the shift
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:10', '11:00', 'Running', '2026-10-12/A', 'provisional', 1],
      ['E1', '11:00', '11:00', 'Running', '2026-10-12/B', 'provisional', 1],
    ]);
    await send(feed.cycle('cnc-b', E1, 4, at('11:00:40')));
    await equipment.flush();
    const rows = await storedPieces(db);
    expect(
      rows.find((r) => r.equipment === 'cnc-a' && r.shift_key.endsWith('B'))?.end_time,
    ).toEqual(new Date(at('11:00:40')));
  });

  it('scopes intervals per epoch: a new epoch closes the old one, and time may go back', async () => {
    const { db, start, send } = await setup();
    const equipment = await start();
    await send(
      feed.state('cnc-a', E1, 1, at('10:00'), 'Running'),
      feed.cycle('cnc-b', E1, 1, at('10:40')),
    );
    // The simulator restarts with the same start time: the new run's clock is earlier.
    await send(feed.snapshot('cnc-a', E2, at('09:00'), 'Off'));
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:00', '10:40', 'Running', '2026-10-12/A', 'final', 1],
    ]);
    await send(
      feed.state('cnc-a', E2, 1, at('09:05'), 'Running'),
      feed.cycle('cnc-b', E2, 1, at('09:30')),
      // A late fact of the old run on another machine moves the old epoch's watermark, but not
      // the interval cnc-a's new epoch already closed.
      feed.cycle('cnc-c', E1, 7, at('10:50')),
    );
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:00', '10:40', 'Running', '2026-10-12/A', 'final', 1],
      ['E2', '09:00', '09:05', 'Off', '2026-10-12/A', 'final', null],
      ['E2', '09:05', '09:30', 'Running', '2026-10-12/A', 'provisional', 1],
    ]);
    expect(equipment.currentState('cnc-a')).toMatchObject({ epoch: E2, state: 'Running' });
    expect(equipment.watermark(E1)).toEqual(new Date(at('10:50')));
    expect(equipment.watermark(E2)).toEqual(new Date(at('09:30')));
    const totals = await equipment.shiftTotals('2026-10-12/A', { equipment: 'cnc-a', epoch: E2 });
    expect(totals.map((t) => [t.state, t.ms])).toEqual([
      ['Off', 5 * 60_000],
      ['Running', 25 * 60_000],
    ]);
  });

  it('starts from the anchor when no fact precedes it; the first anchor of an epoch wins', async () => {
    const { db, start, send } = await setup();
    await start();
    await send(
      feed.snapshot('cnc-a', E1, at('03:00'), 'Idle'),
      feed.cycle('cnc-b', E1, 1, at('03:10')),
    );
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '03:00', '03:10', 'Idle', '2026-10-12/A', 'provisional', null],
    ]);
    // A later snapshot of the same epoch is the current state, not a new start.
    await send(feed.snapshot('cnc-a', E1, at('03:12'), 'Down'));
    await send(feed.state('cnc-a', E1, 5, at('03:20'), 'Running'));
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '03:00', '03:20', 'Idle', '2026-10-12/A', 'final', null],
    ]);
    // An anchor arriving after a later fact still opens the first interval…
    await send(
      feed.state('cnc-c', E1, 3, at('04:00'), 'Running'),
      feed.snapshot('cnc-c', E1, at('03:30'), 'Idle'),
    );
    // …but not one that is later than the first fact: facts drive intervals.
    await send(
      feed.state('cnc-d', E1, 3, at('04:00'), 'Running'),
      feed.snapshot('cnc-d', E1, at('04:30'), 'Idle'),
      feed.cycle('cnc-b', E1, 2, at('05:00')),
    );
    expect(await pieces(db, 'cnc-c')).toEqual([
      ['E1', '03:30', '04:00', 'Idle', '2026-10-12/A', 'final', null],
      ['E1', '04:00', '05:00', 'Running', '2026-10-12/A', 'provisional', 3],
    ]);
    expect(await pieces(db, 'cnc-d')).toEqual([
      ['E1', '04:00', '05:00', 'Running', '2026-10-12/A', 'provisional', 3],
    ]);
  });

  it('is reorder-safe and idempotent: shuffled, duplicated delivery stores the same intervals', async () => {
    const STATES = ['Running', 'Idle', 'Down', 'Stopped', 'Blocked'] as const;
    const next = random(96);
    const deliveries: Delivery[] = [];
    const machines = ['cnc-a', 'cnc-b', 'lkt-x'];
    for (const machine of machines) {
      deliveries.push(feed.snapshot(machine, E1, at('02:30'), 'Off'));
      let time = at('02:30');
      for (let seq = 1; seq <= 60; seq++) {
        // Bursts in the same millisecond, boundaries hit exactly, and long gaps across shifts.
        const roll = next();
        time +=
          roll < 0.15
            ? 0
            : roll < 0.25
              ? 3_600_000 - (time % 3_600_000)
              : Math.floor(next() * 5_400_000);
        const state = STATES[Math.floor(next() * STATES.length)] ?? 'Idle';
        deliveries.push(
          next() < 0.75
            ? feed.state(machine, E1, seq, time, state, state === 'Down' ? 'X' : null)
            : feed.cycle(machine, E1, seq, time),
        );
      }
    }
    // The end of the observation, after every fact: a device fact, so that a recompute from the
    // tables alone knows the watermark too (telemetry's survives only in the stored intervals).
    const end = feed.cycle('wsh-01', E1, 2, at('22:00', 16));
    const wshFact = feed.state('wsh-01', E1, 1, at('02:30'), 'Idle');

    const inOrder = await setup();
    await inOrder.start();
    await inOrder.send(wshFact, ...deliveries, end);

    const shuffled = await setup();
    const equipment = await shuffled.start();
    const mixed = shuffle([...deliveries, ...deliveries.filter(() => next() < 0.3)], next);
    await shuffled.send(wshFact, ...mixed, end, ...mixed.slice(0, 20));
    await equipment.flush();

    const expected = await storedPieces(inOrder.db);
    expect(expected.length).toBeGreaterThan(100);
    expect(await storedPieces(shuffled.db)).toEqual(expected);

    // A recompute from the tables alone agrees as well.
    await equipment.stop();
    await shuffled.db.deleteFrom('equipment.interval_source').execute();
    await shuffled.db.deleteFrom('equipment.equipment_state_interval').execute();
    await shuffled.start();
    expect(await storedPieces(shuffled.db)).toEqual(expected);
  });

  it('catches up from the tables after an MES restart mid-stream', async () => {
    const reference = await setup();
    const restarted = await setup();
    const deliveries: Delivery[] = [];
    let time = at('05:00');
    for (let seq = 1; seq <= 40; seq++) {
      time += 7 * 60_000 + seq * 1_000;
      deliveries.push(
        feed.state('cnc-a', E1, seq, time, seq % 3 === 0 ? 'Idle' : 'Running'),
        feed.cycle('cnc-b', E1, seq, time + 30_000),
      );
    }
    await reference.start();
    await reference.send(feed.snapshot('cnc-a', E1, at('05:00'), 'Off'), ...deliveries);

    const logs: object[] = [];
    const log = { info: (o: object) => logs.push(o), error: () => undefined };
    const first = await restarted.start({ log });
    await restarted.send(
      feed.snapshot('cnc-a', E1, at('05:00'), 'Off'),
      ...deliveries.slice(0, 31),
    );
    await first.stop(); // the MES goes down; ingest's tables keep filling (broker redelivery)
    await restarted.send(...deliveries.slice(31));
    const second = await restarted.start({ log });
    expect(await storedPieces(restarted.db)).toEqual(await storedPieces(reference.db));
    expect(second.currentState('cnc-a')).toEqual((await reference.start()).currentState('cnc-a'));
    // A restart with nothing new recomputes nothing.
    await second.stop();
    await restarted.start({ log });
    expect(logs.at(-1)).toMatchObject({ rebuilt: 0 });
    expect(await storedPieces(restarted.db)).toEqual(await storedPieces(reference.db));
  });

  it('hears of a fact whose commit was applied but reported failed (ingest re-announces it)', async () => {
    const { db, ingest, start, send } = await setup();
    const equipment = await start();
    await send(feed.state('cnc-a', E1, 1, at('03:00'), 'Running'));
    // As if the next commit reached the database but the client saw an error: row stored,
    // cursor and listeners not told.
    const fact = feed.state('cnc-a', E1, 2, at('03:30'), 'Idle');
    await db
      .insertInto('ingest.equipment_event')
      .values({
        equipment: 'cnc-a',
        epoch: E1,
        seq: 2,
        source_time: new Date(at('03:30')),
        event_type: 'state',
        topic: fact.topic,
        state: 'Idle',
        cause: null,
        quality: 'good',
        source_protocol: 'opcua',
        received_at: new Date(),
        payload: fact.payload,
      })
      .execute();
    await send(fact); // the broker's redelivery
    expect(ingest.count('duplicate')).toBe(1);
    expect(equipment.currentState('cnc-a')).toMatchObject({ state: 'Idle', seq: 2 });
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '03:00', '03:30', 'Running', '2026-10-12/A', 'final', 1],
    ]);
    // The re-announced fact is counted once: a restart finds nothing to recompute, twice.
    const logs: object[] = [];
    const log = { info: (o: object) => logs.push(o), error: () => undefined };
    await equipment.stop();
    await (await start({ log })).stop();
    await start({ log });
    expect(logs).toEqual([
      expect.objectContaining({ rebuilt: 0 }),
      expect.objectContaining({ rebuilt: 0 }),
    ]);
  });

  it("never credits a new run's telemetry to the old epoch, not even after an MES restart", async () => {
    const { db, start, send } = await setup();
    let equipment = await start();
    await send(
      feed.state('cnc-a', E1, 1, at('10:00'), 'Running'),
      feed.cycle('cnc-b', E1, 1, at('10:40')),
      feed.telemetry('cnc-a', at('10:45'), E1),
    );
    const before = await pieces(db, 'cnc-a');
    expect(before).toEqual([['E1', '10:00', '10:45', 'Running', '2026-10-12/A', 'provisional', 1]]);
    // A gateway older than contract 1.1 says nothing about the run: no watermark at all.
    await send(feed.telemetry('cnc-a', at('11:30', 14)));
    expect(await pieces(db, 'cnc-a')).toEqual(before);

    // The simulator restarts (the run's clock now two days later, as with another SIM_START) and
    // the collector's telemetry monitors deliver before its resync publishes the snapshot.
    await equipment.stop();
    equipment = await start(); // an MES restart in between: catch-up from the tables
    expect(await pieces(db, 'cnc-a')).toEqual(before);
    await send(feed.telemetry('cnc-a', at('11:30', 14), E2));
    // The new run closes the old one at the old run's watermark, and only the new run moves on.
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:00', '10:45', 'Running', '2026-10-12/A', 'final', 1],
    ]);
    expect(equipment.watermark(E1)).toEqual(new Date(at('10:45')));
    expect(equipment.watermark(E2)).toEqual(new Date(at('11:30', 14)));
    // Late samples of the old run never move it once the equipment left it.
    await send(feed.telemetry('cnc-a', at('12:00'), E1), feed.telemetry('cnc-b', at('12:00'), E1));
    await send(feed.snapshot('cnc-a', E2, at('11:00', 14), 'Idle'));
    await send(feed.telemetry('cnc-a', at('11:40', 14), E2));
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:00', '10:45', 'Running', '2026-10-12/A', 'final', 1],
      ['E2', '11:00', '11:40', 'Idle', '2026-10-14/B', 'provisional', null],
    ]);
    await equipment.stop();
    await start(); // and again after a restart
    expect((await pieces(db, 'cnc-a'))[0]).toEqual(
      before[0]?.map((v) => (v === 'provisional' ? 'final' : v)),
    );
  });

  it('handles a device clock that goes back with one recompute, then window by window', async () => {
    const { db, ingest, send } = await setup();
    let rebuilds = 0;
    const source = {
      onStored: ingest.onStored.bind(ingest),
      stateFacts: async (...args: Parameters<Ingest['stateFacts']>) => {
        if (args[2] === undefined) rebuilds++;
        return ingest.stateFacts(...args);
      },
      stateFactWindow: ingest.stateFactWindow.bind(ingest),
      stateFactCount: ingest.stateFactCount.bind(ingest),
      latestStateTime: ingest.latestStateTime.bind(ingest),
      anchor: ingest.anchor.bind(ingest),
      anchors: ingest.anchors.bind(ingest),
      factSummary: ingest.factSummary.bind(ingest),
    };
    const masterData = new MasterData(db);
    const equipment = new Equipment({
      db,
      source,
      shiftPattern: await masterData.shiftPattern(),
      provisionalStepMs: 0,
    });
    await equipment.start();
    cleanup.push(() => equipment.stop());
    const facts: Delivery[] = [];
    for (let seq = 1; seq <= 120; seq++) {
      // Seq 40 jumps an hour ahead: everything up to seq 70 is moved up to it.
      const time = seq === 40 ? at('14:00') : at('11:00') + seq * 60_000;
      facts.push(feed.state('cnc-a', E1, seq, time, seq % 2 ? 'Running' : 'Idle'));
    }
    const late = [facts[20], facts[39], facts[60], facts[100]] as Delivery[];
    const early = facts.filter((f) => !late.includes(f));
    await send(...early, ...late);
    expect(rebuilds).toBeLessThanOrEqual(2);
    // The result is what a recompute from the tables alone gives.
    const stored = await storedPieces(db);
    await equipment.stop();
    await db.deleteFrom('equipment.interval_source').execute();
    await db.deleteFrom('equipment.equipment_state_interval').execute();
    const fresh = new Equipment({
      db,
      source: ingest,
      shiftPattern: await masterData.shiftPattern(),
    });
    await fresh.start();
    cleanup.push(() => fresh.stop());
    expect(await storedPieces(db)).toEqual(stored);
    expect(stored.some((p) => p.start_seq === 39)).toBe(true);
    expect(stored.some((p) => p.start_seq === 50)).toBe(false); // zero length after the clamp
  });
});
