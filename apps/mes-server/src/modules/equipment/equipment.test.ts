import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { Kysely } from 'kysely';
import { Registry } from 'prom-client';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/database.ts';
import { startDatabase } from '../../testing.ts';
import { Ingest, type IngestOptions } from '../ingest/index.ts';
import { MasterData } from '../master-data/index.ts';
import { Equipment, downtimeRules, type EquipmentChange, type EquipmentOptions } from './index.ts';
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

async function setup(
  options: Partial<EquipmentOptions> = {},
  ingestOptions: Partial<IngestOptions> = {},
) {
  const db = await freshDatabase(serverUrl, 'equipment');
  cleanup.push(() => db.destroy());
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const shiftPattern = await masterData.shiftPattern();
  // Never started: deliveries go through `deliver`, the store path without a broker.
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'unused',
    ...ingestOptions,
  });
  const start = async (more: Partial<EquipmentOptions> = {}): Promise<Equipment> => {
    const equipment = new Equipment({
      db,
      source: ingest,
      shiftPattern,
      provisionalStepMs: 0,
      downtime: downtimeRules(plant),
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
      {
        equipment: 'cnc-a',
        epoch: E1,
        state: 'Down',
        ms: 5 * 60_000,
        provisionalMs: 5 * 60_000,
        revision: 0,
        incidents: 0,
      },
      {
        equipment: 'cnc-a',
        epoch: E1,
        state: 'Running',
        ms: 70 * 60_000,
        provisionalMs: 0,
        revision: 0,
        incidents: 0,
      },
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
    await send(feed.state('cnc-a', E1, 1, at('03:20'), 'Running'));
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '03:00', '03:20', 'Idle', '2026-10-12/A', 'final', null],
    ]);
    // An anchor arriving after a later fact still opens the first interval…
    await send(
      feed.state('cnc-c', E1, 1, at('04:00'), 'Running'),
      feed.snapshot('cnc-c', E1, at('03:30'), 'Idle'),
    );
    // …but not one that is later than the first fact: facts drive intervals.
    await send(
      feed.state('cnc-d', E1, 1, at('04:00'), 'Running'),
      feed.snapshot('cnc-d', E1, at('04:30'), 'Idle'),
      feed.cycle('cnc-b', E1, 2, at('05:00')),
    );
    expect(await pieces(db, 'cnc-c')).toEqual([
      ['E1', '03:30', '04:00', 'Idle', '2026-10-12/A', 'final', null],
      ['E1', '04:00', '05:00', 'Running', '2026-10-12/A', 'provisional', 1],
    ]);
    expect(await pieces(db, 'cnc-d')).toEqual([
      ['E1', '04:00', '05:00', 'Running', '2026-10-12/A', 'provisional', 1],
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

  it('re-anchors the current state at the new run’s snapshot, after telemetry opened the epoch (#272)', async () => {
    const { start, send } = await setup();
    const equipment = await start();
    const changes: EquipmentChange[] = [];
    equipment.onChange((change) => changes.push(change));
    await send(
      feed.state('wsh-01', E1, 1, at('10:00'), 'Running'),
      feed.telemetry('wsh-01', at('10:30'), E1),
    );
    expect(equipment.currentState('wsh-01')).toMatchObject({ epoch: E1, state: 'Running' });
    // The simulator restarts idle with an earlier SIM_START: the gateway's first poll of the new
    // run publishes its telemetry before the snapshot of the same read.
    await send(feed.telemetry('wsh-01', at('09:00'), E2));
    // Until the snapshot arrives, the old run is the newest one with a known state.
    expect(equipment.currentState('wsh-01')).toMatchObject({ epoch: E1, state: 'Running' });
    await send(feed.snapshot('wsh-01', E2, at('09:00'), 'Off'));
    expect(equipment.currentState('wsh-01')).toMatchObject({
      epoch: E2,
      state: 'Off',
      seq: null,
      since: new Date(at('09:00')),
    });
    expect(changes.at(-1)?.current).toMatchObject({ epoch: E2, state: 'Off' });
    expect(equipment.epochEnd('wsh-01', E1).closed).toBe(true);
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
      settled: ingest.settled.bind(ingest),
      cycleCounts: ingest.cycleCounts.bind(ingest),
      hourlyCycleTotals: ingest.hourlyCycleTotals.bind(ingest),
      refreshCyclesThrough: ingest.refreshCyclesThrough.bind(ingest),
    };
    const masterData = new MasterData(db);
    const equipment = new Equipment({
      db,
      source,
      shiftPattern: await masterData.shiftPattern(),
      downtime: downtimeRules(plant),
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
      downtime: downtimeRules(plant),
    });
    await fresh.start();
    cleanup.push(() => fresh.stop());
    expect(await storedPieces(db)).toEqual(stored);
    expect(stored.some((p) => p.start_seq === 39)).toBe(true);
    expect(stored.some((p) => p.start_seq === 50)).toBe(false); // zero length after the clamp
  });
});

/** Final hours of one equipment: [epoch, hour, revision, incidents]. */
async function finalHours(db: Kysely<Database>, equipment: string) {
  const rows = await db
    .selectFrom('equipment.bucket_finality')
    .selectAll()
    .where('equipment', '=', equipment)
    .orderBy('epoch')
    .orderBy('hour')
    .execute();
  return rows.map((row) => [
    row.epoch === E2 ? 'E2' : 'E1',
    hhmm(row.hour),
    row.revision,
    row.incident_ids.length,
  ]);
}

/** Shift totals of one equipment, as [state, ms, provisionalMs, revision, incidents]. */
async function totalsOf(equipment: Equipment, shiftKey: string, id: string, epoch = E1) {
  return (await equipment.shiftTotals(shiftKey, { equipment: id, epoch })).map((t) => [
    t.state,
    t.ms / 60_000,
    t.provisionalMs / 60_000,
    t.revision,
    t.incidents,
  ]);
}

const SHIFT_A = '2026-10-12/A'; // 03:00 to 11:00 UTC
const SHIFT_B = '2026-10-12/B'; // 11:00 to 19:00 UTC

describe('interval finality (#113)', () => {
  it('makes pieces final as the equipment’s own facts arrive, and records final hours', async () => {
    const { db, start, send } = await setup();
    const equipment = await start();
    await send(
      feed.state('cnc-a', E1, 1, at('10:10'), 'Running'),
      feed.cycle('cnc-a', E1, 2, at('10:40')),
      // Another machine moves the watermark, not cnc-a's finality.
      feed.cycle('cnc-b', E1, 1, at('11:20')),
    );
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:10', '11:00', 'Running', SHIFT_A, 'provisional', 1],
      ['E1', '11:00', '11:20', 'Running', SHIFT_B, 'provisional', 1],
    ]);
    expect(await totalsOf(equipment, SHIFT_A, 'cnc-a')).toEqual([['Running', 50, 50, 0, 0]]);
    expect(await finalHours(db, 'cnc-a')).toEqual([]);
    // cnc-a's next cycle, after the shift end, settles everything up to it.
    await send(feed.cycle('cnc-a', E1, 3, at('11:05')));
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:10', '11:00', 'Running', SHIFT_A, 'final', 1],
      ['E1', '11:00', '11:20', 'Running', SHIFT_B, 'provisional', 1],
    ]);
    expect(await totalsOf(equipment, SHIFT_A, 'cnc-a')).toEqual([['Running', 50, 0, 0, 0]]);
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 0, 0]]);
    // A state change keeps the settled pieces final and the open one provisional.
    await send(
      feed.state('cnc-a', E1, 4, at('11:30'), 'Idle'),
      feed.cycle('cnc-b', E1, 2, at('12:10')),
    );
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:10', '11:00', 'Running', SHIFT_A, 'final', 1],
      ['E1', '11:00', '11:30', 'Running', SHIFT_B, 'final', 1],
      ['E1', '11:30', '12:00', 'Idle', SHIFT_B, 'provisional', 4],
      ['E1', '12:00', '12:10', 'Idle', SHIFT_B, 'provisional', 4],
    ]);
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 0, 0]]);
  });

  it('keeps a stop with an unsettled end open, and revises an hour whose stop changes class (#120)', async () => {
    const clock = { now: Date.parse('2026-10-15T10:00:00Z') };
    const { db, ingest, start, send } = await setup(
      {},
      { gapGraceMs: 30_000, sweepIntervalMs: 0, now: () => clock.now },
    );
    const equipment = await start();
    const stopAt = at('10:59') + 30_000;
    const whole = async () =>
      (await equipment.stopPieces(new Date(at('10:00')), new Date(at('11:00')))).map((p) => [
        p.wholeMs / 1_000,
        p.open,
      ]);
    // A stop at 10:59:30; seq 3 (Running at 11:00:20) is late, seq 4 (Running at 11:10) early.
    await send(
      feed.state('cnc-a', E1, 1, at('10:10'), 'Running'),
      feed.state('cnc-a', E1, 2, stopAt, 'Stopped', 'jam'),
      feed.state('cnc-a', E1, 4, at('11:10'), 'Running'),
      feed.cycle('cnc-b', E1, 1, at('11:30')),
    );
    // Its end lies past "final through" (10:59:30): open, its length so far the 30 s of the piece.
    expect(await whole()).toEqual([[30, true]]);
    expect(await finalHours(db, 'cnc-a')).toEqual([]);
    expect(await ingest.sweep()).toBe(0);
    clock.now += 30_000;
    expect(await ingest.sweep()).toBe(1); // the gap is an incident: 10:00 becomes final
    expect(await whole()).toEqual([[630, false]]); // a long stop, 10.5 min
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 0, 1]]);
    // The late fill ends the stop at 11:00:20: a micro-stop. 10:00's pieces are the same, but
    // its OEE changed, so its revision goes up.
    await send(feed.state('cnc-a', E1, 3, at('11:00') + 20_000, 'Running'));
    expect(await whole()).toEqual([[50, false]]);
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 1, 1]]);
  });

  it('does not revise an hour whose stop is filled within the grace period (#120)', async () => {
    const { db, start, send } = await setup();
    const equipment = await start();
    const stopAt = at('10:59') + 30_000;
    // A stop at 10:59:30 and a cycle at 11:00:10 (10:00 final); seq 4 (Running at 11:00:20)
    // is late, seq 5 (Running at 11:10) early.
    await send(
      feed.state('cnc-a', E1, 1, at('10:10'), 'Running'),
      feed.state('cnc-a', E1, 2, stopAt, 'Stopped', 'jam'),
      feed.cycle('cnc-a', E1, 3, at('11:00') + 10_000),
      feed.state('cnc-a', E1, 5, at('11:10'), 'Running'),
      feed.cycle('cnc-b', E1, 1, at('11:30')),
    );
    const stops = await equipment.stopPieces(new Date(at('10:00')), new Date(at('11:00')));
    expect(stops.map((p) => [p.wholeMs / 1_000, p.open])).toEqual([[40, true]]);
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 0, 0]]);
    // The fill within the grace period: the stop was never settled as long, so no revision.
    await send(feed.state('cnc-a', E1, 4, at('11:00') + 20_000, 'Running'));
    const after = await equipment.stopPieces(new Date(at('10:00')), new Date(at('11:00')));
    expect(after.map((p) => [p.wholeMs / 1_000, p.open])).toEqual([[50, false]]);
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 0, 0]]);
  });

  it('holds finality at a gap, releases it with the incident, and revises on a late fill', async () => {
    const clock = { now: Date.parse('2026-10-15T10:00:00Z') };
    const { db, ingest, start, send } = await setup(
      {},
      { gapGraceMs: 30_000, sweepIntervalMs: 0, now: () => clock.now },
    );
    let equipment = await start();
    // Seq 2 (a Down) and 3 (a cycle) are late.
    await send(
      feed.state('cnc-a', E1, 1, at('10:10'), 'Running'),
      feed.cycle('cnc-a', E1, 4, at('10:55')),
      feed.state('cnc-a', E1, 5, at('11:10'), 'Idle'),
      feed.cycle('cnc-b', E1, 1, at('11:30')),
    );
    // Even the closed interval can still change: all of it is provisional.
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:10', '11:00', 'Running', SHIFT_A, 'provisional', 1],
      ['E1', '11:00', '11:10', 'Running', SHIFT_B, 'provisional', 1],
      ['E1', '11:10', '11:30', 'Idle', SHIFT_B, 'provisional', 5],
    ]);
    expect(await totalsOf(equipment, SHIFT_A, 'cnc-a')).toEqual([['Running', 50, 50, 0, 0]]);
    expect(await ingest.sweep()).toBe(0);
    clock.now += 30_000;
    expect(await ingest.sweep()).toBe(1); // the gap is an incident now
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:10', '11:00', 'Running', SHIFT_A, 'final', 1],
      ['E1', '11:00', '11:10', 'Running', SHIFT_B, 'final', 1],
      ['E1', '11:10', '11:30', 'Idle', SHIFT_B, 'provisional', 5],
    ]);
    expect(await totalsOf(equipment, SHIFT_A, 'cnc-a')).toEqual([['Running', 50, 0, 0, 1]]);
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 0, 1]]);

    // The late fill (ADR-0017 still stores it) changes a final hour: its revision goes up.
    await send(feed.state('cnc-a', E1, 2, at('10:30'), 'Down', 'X'));
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:10', '10:30', 'Running', SHIFT_A, 'final', 1],
      ['E1', '10:30', '11:00', 'Down', SHIFT_A, 'final', 2],
      ['E1', '11:00', '11:10', 'Down', SHIFT_B, 'final', 2],
      ['E1', '11:10', '11:30', 'Idle', SHIFT_B, 'provisional', 5],
    ]);
    expect(await totalsOf(equipment, SHIFT_A, 'cnc-a')).toEqual([
      ['Down', 30, 0, 1, 1],
      ['Running', 20, 0, 1, 1],
    ]);
    // A late cycle changes the hour's count, so it revises it too, and tells the pieces'
    // listeners (#257: a final order or line OEE over the hour carries its revision).
    const told: { equipment: string; from: string; to: string }[] = [];
    const stop = equipment.onPiecesChanged((change) =>
      told.push({
        equipment: change.equipment,
        from: change.from.toISOString(),
        to: change.to.toISOString(),
      }),
    );
    await send(feed.cycle('cnc-a', E1, 3, at('10:45')));
    stop();
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 2, 1]]);
    expect(told).toContainEqual({
      equipment: 'cnc-a',
      from: new Date(at('10:00')).toISOString(),
      to: new Date(at('11:00')).toISOString(),
    });
    const [incident] = await db.selectFrom('ingest.data_quality_incident').selectAll().execute();
    expect(incident).toMatchObject({ seq_from: 2, seq_to: 3, resolution: 'filled' });
    const revised = await finalHours(db, 'cnc-a');
    const before = await storedPieces(db);

    // A restart keeps the revisions, the incidents and the flags.
    await equipment.stop();
    equipment = await start();
    expect(await finalHours(db, 'cnc-a')).toEqual(revised);
    expect(await storedPieces(db)).toEqual(before);
    expect(await totalsOf(equipment, SHIFT_A, 'cnc-a')).toEqual([
      ['Down', 30, 0, 2, 1],
      ['Running', 20, 0, 2, 1],
    ]);
    // A further fact carries on from the remembered finality.
    await send(feed.cycle('cnc-a', E1, 6, at('12:05')));
    expect(await finalHours(db, 'cnc-a')).toEqual([
      ['E1', '10:00', 2, 1],
      ['E1', '11:00', 0, 0],
    ]);

    // Pieces stored before #113 (flags of the old rule, no final hours): a restart brings both
    // in line with the current rule.
    const settled = await storedPieces(db);
    await equipment.stop();
    await db.updateTable('equipment.equipment_state_interval').set({ provisional: true }).execute();
    await db.deleteFrom('equipment.bucket_finality').execute();
    await start();
    expect(await storedPieces(db)).toEqual(settled);
    expect(await finalHours(db, 'cnc-a')).toEqual([
      ['E1', '10:00', 0, 1],
      ['E1', '11:00', 0, 0],
    ]);
  });

  it('settles a stream first seen above 1 once its history is written off, without an incident', async () => {
    const clock = { now: Date.parse('2026-10-15T10:00:00Z') };
    const registry = new Registry();
    const warnings: object[] = [];
    const log = {
      info: () => undefined,
      warn: (o: object) => warnings.push(o),
      error: () => undefined,
    };
    const { db, ingest, start, send } = await setup(
      {},
      { gapGraceMs: 30_000, sweepIntervalMs: 0, now: () => clock.now, registry, log },
    );
    await start();
    // The MES joins a running stream at 5: 1 to 4 may still be in flight (a reordered replay).
    await send(
      feed.state('cnc-a', E1, 5, at('10:10'), 'Running'),
      feed.cycle('cnc-a', E1, 6, at('11:05')),
      feed.cycle('cnc-b', E1, 1, at('11:20')),
    );
    expect((await pieces(db, 'cnc-a'))[0]?.[5]).toBe('provisional');
    expect(await ingest.sweep()).toBe(0); // seen open from now on
    clock.now += 30_000;
    expect(await ingest.sweep()).toBe(0); // history, not a gap: no incident
    // …but visible: a warning and a metric per stream written off.
    expect(warnings).toContainEqual(
      expect.objectContaining({ stream: 'device:cnc-a', from: 1, to: 4 }),
    );
    expect(await registry.metrics()).toMatch(/^mes_ingest_history_written_off_total 1$/m);
    expect(await db.selectFrom('ingest.data_quality_incident').selectAll().execute()).toEqual([]);
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:10', '11:00', 'Running', SHIFT_A, 'final', 5],
      ['E1', '11:00', '11:20', 'Running', SHIFT_B, 'provisional', 5],
    ]);
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 0, 0]]);
  });

  it('recomputes before finality when a jump passes a state fact it never heard of', async () => {
    const { db, send } = await setup();
    const masterData = new MasterData(db);
    await send(feed.state('cnc-a', E1, 1, at('10:00'), 'Running'));
    // A second ingest process: like a resumed session, it loads its cursors from the table.
    const resumed = new Ingest({
      db,
      url: 'mqtt://127.0.0.1:1',
      username: 'mes',
      password: 'unused',
    });
    const equipment = new Equipment({
      db,
      source: resumed,
      shiftPattern: await masterData.shiftPattern(),
      downtime: downtimeRules(plant),
      provisionalStepMs: 0,
    });
    await equipment.start();
    cleanup.push(() => equipment.stop());
    // Seq 2's commit was applied but reported failed; the session was suspended, the cursors
    // reloaded, and its redelivery is a duplicate: no notice ever tells of it (ADR-0017).
    const missed = feed.state('cnc-a', E1, 2, at('10:20'), 'Down', 'X');
    await db
      .insertInto('ingest.equipment_event')
      .values({
        equipment: 'cnc-a',
        epoch: E1,
        seq: 2,
        source_time: new Date(at('10:20')),
        event_type: 'state',
        topic: missed.topic,
        state: 'Down',
        cause: 'X',
        quality: 'good',
        source_protocol: 'opcua',
        received_at: new Date(),
        payload: missed.payload,
      })
      .execute();
    await db
      .updateTable('ingest.source_cursor')
      .set({ seen: JSON.stringify([[1, 2]]) })
      .where('stream', '=', 'device:cnc-a')
      .execute();
    await resumed.deliver(missed.topic, missed.payload); // the duplicate redelivery
    expect(resumed.count('duplicate')).toBe(1);
    // The next fact moves the settled part past seq 2: the module notices the missing fact.
    const next = feed.cycle('cnc-a', E1, 3, at('10:40'));
    await resumed.deliver(next.topic, next.payload);
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:00', '10:20', 'Running', SHIFT_A, 'final', 1],
      ['E1', '10:20', '10:40', 'Down', SHIFT_A, 'final', 2],
    ]);
    expect(equipment.currentState('cnc-a')).toMatchObject({ state: 'Down', seq: 2 });
  });

  it('gives a closed epoch’s final hours the gaps that its end turned into incidents', async () => {
    const { db, start, send } = await setup();
    await start();
    // Seq 2 is missing, not reported yet; the new run's telemetry closes the epoch first.
    await send(
      feed.state('cnc-a', E1, 1, at('10:10'), 'Running'),
      feed.state('cnc-a', E1, 3, at('10:30'), 'Idle'),
      feed.cycle('cnc-b', E1, 1, at('10:50')),
      feed.telemetry('cnc-a', at('08:00'), E2),
    );
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 0, 0]]);
    // The new run's first fact ends the old epoch in ingest: its gap becomes an incident.
    await send(feed.state('cnc-a', E2, 1, at('08:05'), 'Idle'));
    const incidents = await db.selectFrom('ingest.data_quality_incident').selectAll().execute();
    expect(incidents).toMatchObject([{ seq_from: 2, seq_to: 2, resolution: 'epoch-ended' }]);
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 0, 1]]);
  });

  it('makes a closed epoch final everywhere; its late facts raise the revision', async () => {
    const { db, start, send } = await setup();
    const equipment = await start();
    await send(
      feed.state('cnc-a', E1, 1, at('10:10'), 'Running'),
      feed.cycle('cnc-a', E1, 2, at('10:20')),
      feed.cycle('cnc-b', E1, 1, at('10:50')),
    );
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:10', '10:50', 'Running', SHIFT_A, 'provisional', 1],
    ]);
    // The new run's telemetry closes the old epoch: final, every hour recorded.
    await send(feed.telemetry('cnc-a', at('08:00'), E2));
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:10', '10:50', 'Running', SHIFT_A, 'final', 1],
    ]);
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 0, 0]]);
    expect(await totalsOf(equipment, SHIFT_A, 'cnc-a')).toEqual([['Running', 40, 0, 0, 0]]);
    // Late facts of the old run (in flight when it closed) are still stored, and revise.
    await send(feed.state('cnc-a', E1, 3, at('10:30'), 'Idle'));
    await send(feed.cycle('cnc-a', E1, 4, at('10:40')));
    expect(await pieces(db, 'cnc-a')).toEqual([
      ['E1', '10:10', '10:30', 'Running', SHIFT_A, 'final', 1],
      ['E1', '10:30', '10:50', 'Idle', SHIFT_A, 'final', 3],
    ]);
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 2, 0]]);
    expect(await totalsOf(equipment, SHIFT_A, 'cnc-a')).toEqual([
      ['Idle', 20, 0, 2, 0],
      ['Running', 20, 0, 2, 0],
    ]);
  });

  it('keeps a silent machine provisional across a shift end until its next fact', async () => {
    const { db, start, send } = await setup();
    const equipment = await start();
    // Down at 13:30 local; the repair ends after the A/B handover (14:00 local, 11:00 UTC).
    await send(
      feed.state('cnc-a', E1, 1, at('10:30'), 'Down', 'SPINDLE-FAULT'),
      feed.cycle('cnc-b', E1, 1, at('11:15')),
      // Telemetry of the run is no fact of cnc-a: it says nothing about cnc-a's state.
      feed.telemetry('cnc-a', at('11:40'), E1),
    );
    expect(await totalsOf(equipment, SHIFT_A, 'cnc-a')).toEqual([['Down', 30, 30, 0, 0]]);
    expect(await finalHours(db, 'cnc-a')).toEqual([]);
    await send(feed.state('cnc-a', E1, 2, at('11:20'), 'Idle'));
    expect(await totalsOf(equipment, SHIFT_A, 'cnc-a')).toEqual([['Down', 30, 0, 0, 0]]);
    expect(await totalsOf(equipment, SHIFT_B, 'cnc-a')).toEqual([
      ['Down', 20, 0, 0, 0],
      ['Idle', 20, 20, 0, 0],
    ]);
    expect(await finalHours(db, 'cnc-a')).toEqual([['E1', '10:00', 0, 0]]);
  });
});
