import { alarmSnapshotTopic, type AlarmSnapshot } from '@shopfloor/contracts';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { buildMesHttp } from './http.ts';
import { Alarms, type AlarmKpiBucket } from './modules/alarms/index.ts';
import { DowntimeCoding, Equipment, downtimeRules } from './modules/equipment/index.ts';
import {
  PLANT_CONFIG,
  UnsFeed,
  freshDatabase,
  type Delivery,
} from './modules/equipment/test-support.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData } from './modules/master-data/index.ts';
import { Oee } from './modules/oee/index.ts';
import { WS_PATH, serverMessageSchema, type ServerMessage } from './modules/realtime/index.ts';
import {
  alarmDetailSchema,
  alarmHistorySchema,
  alarmKpiListSchema,
  alarmListSchema,
  alarmScopesSchema,
  badActorListSchema,
  floodListSchema,
  problemSchema,
} from './modules/realtime/schemas.ts';
import { startDatabase } from './testing.ts';

/**
 * The `alarms` module (#142): occurrences from facts (pairing, reordering, superseded), retained
 * anchors and old epochs, lost clears closed by a resync snapshot, epoch ends, catch-up, finality
 * and the revisions of late facts, the read API and push. Facts go through `Ingest.deliver`, the
 * store path without a broker.
 */

const E1 = 1_760_000_000;
const E2 = 1_760_050_000;
const MINUTE = 60_000;
/** Monday 2026-10-12 03:00 UTC (shift A starts) plus minutes. */
const T0 = Date.parse('2026-10-12T03:00:00.000Z');
const t = (minutes: number, ms = 0): number => T0 + minutes * MINUTE + ms;
const iso = (at: number): string => new Date(at).toISOString();
const HOUR3 = '2026-10-12T03:00:00.000Z';
const HOUR4 = '2026-10-12T04:00:00.000Z';
const HOUR5 = '2026-10-12T05:00:00.000Z';
const HOUR6 = '2026-10-12T06:00:00.000Z';
const PATH = { area: 'machining', workCenter: 'cell-m1', equipment: 'cnc-01' } as const;
const feed = new UnsFeed(new Map([['cnc-01', PATH]]));
const CP = 'COOLANT-PRESSURE';
const SO = 'SPINDLE-OVERLOAD';

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

interface Mes {
  db: Kysely<Database>;
  ingest: Ingest;
  equipment: Equipment;
  masterData: MasterData;
  alarms: Alarms;
  clock: { now: number };
  send: (...deliveries: Delivery[]) => Promise<void>;
  retained: (...deliveries: Delivery[]) => Promise<void>;
  startAlarms: () => Promise<Alarms>;
}

/** Per test: its own database, ingest (manual sweeps), equipment and alarms. */
async function setup(): Promise<Mes> {
  const db = await freshDatabase(serverUrl, 'alarms');
  cleanup.push(() => db.destroy());
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const clock = { now: Date.parse('2026-10-15T10:00:00Z') };
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'unused',
    gapGraceMs: 5_000,
    sweepIntervalMs: 0,
    now: () => clock.now,
  });
  const equipment = new Equipment({
    db,
    source: ingest,
    shiftPattern: plant.shifts,
    provisionalStepMs: 0,
    downtime: downtimeRules(plant),
  });
  await equipment.start();
  cleanup.push(() => equipment.stop());
  const startAlarms = async (): Promise<Alarms> => {
    const alarms = new Alarms({
      db,
      ingest,
      equipment,
      masterData,
      shiftPattern: plant.shifts,
      config: plant.alarms.kpi,
    });
    await alarms.start();
    cleanup.push(() => alarms.stop());
    return alarms;
  };
  const alarms = await startAlarms();
  return {
    db,
    ingest,
    equipment,
    masterData,
    alarms,
    clock,
    startAlarms,
    send: async (...deliveries) => {
      for (const d of deliveries) await ingest.deliver(d.topic, d.payload);
    },
    retained: async (...deliveries) => {
      for (const d of deliveries) await ingest.deliver(d.topic, d.payload, true);
    },
  };
}

const state = (epoch: number, seq: number, at: number, value: 'Running' | 'Stopped' = 'Running') =>
  feed.state('cnc-01', epoch, seq, at, value, value === 'Stopped' ? 'PART-MISFEED' : null);
const raise = (epoch: number, seq: number, at: number, code = CP) =>
  feed.alarm('cnc-01', epoch, seq, at, code, 'active', 700);
const clear = (epoch: number, seq: number, at: number, code = CP) =>
  feed.alarm('cnc-01', epoch, seq, at, code, 'cleared', 700);

function snapshot(deviceEpoch: number, asOfSeq: number, at: number, active: string[]): Delivery {
  const message: AlarmSnapshot = {
    schema: 'uns.alarm-snapshot/1',
    kind: 'snapshot',
    scope: 'topic',
    epoch: 1_760_100_000,
    seq: asOfSeq,
    deviceEpoch,
    asOfSeq,
    sourceTime: iso(at),
    receivedAt: '2026-10-15T10:00:00.000Z',
    quality: 'good',
    source: { id: 'cnc-01', protocol: 'opcua' },
    value: { active },
  };
  return { topic: alarmSnapshotTopic(PATH), payload: JSON.stringify(message) };
}

/** Every occurrence, active and ended, oldest raise first, as [seq, code, raise, end, reason]. */
async function occurrences(alarms: Alarms, epoch?: number) {
  const all = [
    ...(await alarms.list({ view: 'active', limit: 1000 })),
    ...(await alarms.list({ view: 'history', limit: 1000 })),
  ]
    .filter((o) => epoch === undefined || o.epoch === epoch)
    .sort((a, b) => a.epoch - b.epoch || a.seq - b.seq);
  return all.map((o) => [
    o.seq,
    o.code,
    o.source,
    o.raisedAt.getTime(),
    o.endedAt?.getTime() ?? null,
    o.endReason,
  ]);
}

const equipmentHours = async (alarms: Alarms, epoch = E1): Promise<Map<string, AlarmKpiBucket>> =>
  new Map(
    (
      await alarms.kpis({
        scope: 'equipment',
        id: 'cnc-01',
        bucket: 'hour',
        from: new Date(t(0)),
        to: new Date(t(6 * 60)),
        epoch,
      })
    ).map((b) => [b.key, b]),
  );

/** Two sweeps a grace period apart: the gap is seen, then reported (written off as an incident). */
async function writeOff(mes: Mes): Promise<void> {
  await mes.ingest.sweep();
  mes.clock.now += 6_000;
  expect(await mes.ingest.sweep()).toBe(1);
}

const revisions = async (db: Kysely<Database>) =>
  (
    await db
      .selectFrom('alarms.kpi_revision')
      .selectAll()
      .orderBy('scope')
      .orderBy('hour')
      .execute()
  ).map((r) => [r.scope, r.hour.toISOString(), r.revision]);

const storedRows = (db: Kysely<Database>) =>
  db
    .selectFrom('alarms.alarm_occurrence')
    .select(['equipment', 'epoch', 'seq', 'code', 'source', 'raised_at', 'ended_at'])
    .select(['end_reason', 'end_seq', 'priority', 'defined', 'severity', 'updated_at'])
    .orderBy('seq')
    .execute();

describe('alarm occurrences from facts (#142)', () => {
  const facts = () => [
    state(E1, 1, t(0)),
    raise(E1, 2, t(10)),
    raise(E1, 3, t(20), SO),
    clear(E1, 4, t(30)),
    raise(E1, 5, t(40), SO),
    clear(E1, 6, t(50), SO),
    state(E1, 7, t(65), 'Stopped'),
  ];

  it('pairs raises and clears per code by seq, supersedes a raise whose clear was lost, and computes the KPIs on read', async () => {
    const mes = await setup();
    await mes.send(...facts());
    expect(await occurrences(mes.alarms)).toEqual([
      [2, CP, 'fact', t(10), t(30), 'cleared'],
      [3, SO, 'fact', t(20), t(40), 'superseded'],
      [5, SO, 'fact', t(40), t(50), 'cleared'],
    ]);
    // Cleared but not acknowledged: still in the active list (#143), newest first.
    const [occurrence] = await mes.alarms.list({ view: 'active', limit: 1 });
    expect(occurrence).toMatchObject({
      id: `cnc-01~${String(E1)}~5`,
      priority: 'high',
      defined: true,
      final: true,
      endSeq: 6,
      state: 'unacked-cleared',
    });
    const hours = await equipmentHours(mes.alarms);
    const hour = hours.get(HOUR3);
    expect(hour?.kpis).toMatchObject({
      raises: 3,
      byPriority: { high: 2, medium: 1, low: 0 },
      activeMs: 50 * MINUTE,
      peak10: 1,
      activeAtEnd: 0,
      provisional: false,
    });
    // Final through 04:05 (the last fact): 03:00 is final, the hour in progress 04:00 is not.
    expect([hour?.final, hour?.revision, hour?.incidents]).toEqual([true, 0, 0]);
    expect(hours.get(HOUR4)?.final).toBe(false);
    // The plant waits for every machine (the others never reported): not final.
    const [plantShift] = await mes.alarms.kpis({
      scope: 'plant',
      id: 'plant',
      bucket: 'shift',
      from: new Date(t(0)),
      to: new Date(t(60)),
    });
    expect([plantShift?.key, plantShift?.kpis.raises, plantShift?.final]).toEqual([
      '2026-10-12/A',
      3,
      false,
    ]);
  });

  it('derives the same occurrences from facts in any order', async () => {
    const reference = await setup();
    await reference.send(...facts());
    const reversed = await setup();
    await reversed.send(...facts().reverse());
    const rows = async (mes: Mes) =>
      (await storedRows(mes.db)).map((row) => ({ ...row, updated_at: null }));
    expect(await rows(reversed)).toEqual(await rows(reference));
    expect(await occurrences(reversed.alarms)).toEqual(await occurrences(reference.alarms));
  });
});

describe('alarm anchors and old epochs (#142, ADR-0017 amendment)', () => {
  it('opens an occurrence from a retained raise of the newest epoch; its fact replaces it', async () => {
    const mes = await setup();
    await mes.retained(raise(E1, 3, t(3), SO));
    expect(await occurrences(mes.alarms)).toEqual([[3, SO, 'anchor', t(3), null, null]]);
    await mes.send(state(E1, 1, t(0)), state(E1, 2, t(1)), raise(E1, 3, t(3), SO));
    expect(await occurrences(mes.alarms)).toEqual([[3, SO, 'fact', t(3), null, null]]);
  });

  it('never lists the retained alarms of a restarted simulator as active, in either order', async () => {
    // The old run's anchor first: used while E1 is the newest, then ended by the new run.
    const first = await setup();
    await first.retained(raise(E1, 4, t(5)));
    expect((await first.alarms.list({ view: 'active', limit: 10 })).map((o) => o.id)).toEqual([
      `cnc-01~${String(E1)}~4`,
    ]);
    await first.send(state(E2, 1, t(0)));
    expect(await first.alarms.list({ view: 'active', limit: 10 })).toEqual([]);
    expect(await occurrences(first.alarms, E1)).toEqual([
      [4, CP, 'anchor', t(5), t(5), 'epoch-ended'],
    ]);
    // The new run first: the old anchor arrives stale and is never used.
    const second = await setup();
    await second.send(state(E2, 1, t(0)));
    await second.retained(raise(E1, 4, t(5)), snapshot(E1, 4, t(5), [CP]));
    expect(await occurrences(second.alarms)).toEqual([]);
  });

  it('ends what is open at the old epoch’s close when a newer epoch arrives', async () => {
    const mes = await setup();
    await mes.send(state(E1, 1, t(0)), raise(E1, 2, t(10)), state(E1, 3, t(40), 'Stopped'));
    await mes.send(state(E2, 1, t(0)));
    expect(await occurrences(mes.alarms)).toEqual([[2, CP, 'fact', t(10), t(40), 'epoch-ended']]);
    // A closed epoch is final everywhere.
    expect((await equipmentHours(mes.alarms, E1)).get(HOUR3)?.final).toBe(true);
  });
});

describe('lost clears, late facts and revisions (#142, ADR-0024 "Revisions")', () => {
  it('closes a lost clear at a snapshot once settled up to it; the real clear replaces it with a revision', async () => {
    const mes = await setup();
    // The clear at seq 3 is lost in a gap; the gateway's resync snapshot at seq 4 shows it inactive.
    await mes.send(state(E1, 1, t(0)), raise(E1, 2, t(5)), state(E1, 4, t(30), 'Stopped'));
    await mes.retained(snapshot(E1, 4, t(30), []));
    // Not settled up to asOfSeq 4 yet (seq 3 may still come): the snapshot waits.
    expect(await occurrences(mes.alarms)).toEqual([[2, CP, 'fact', t(5), null, null]]);
    await writeOff(mes);
    expect(await occurrences(mes.alarms)).toEqual([[2, CP, 'fact', t(5), t(30), 'lost']]);
    // Final through 05:05: hours 03:00 and 04:00 are final, the gap incident over 03:00.
    await mes.send(state(E1, 5, t(125)));
    let hours = await equipmentHours(mes.alarms);
    expect([hours.get(HOUR3)?.final, hours.get(HOUR3)?.kpis.activeMs]).toEqual([true, 25 * MINUTE]);
    expect([hours.get(HOUR3)?.revision, hours.get(HOUR3)?.incidents]).toEqual([0, 1]);
    // The real clear arrives late: it replaces the snapshot's end; hour 03:00 is revised.
    await mes.send(clear(E1, 3, t(6)));
    expect(await occurrences(mes.alarms)).toEqual([[2, CP, 'fact', t(5), t(6), 'cleared']]);
    hours = await equipmentHours(mes.alarms);
    expect([hours.get(HOUR3)?.kpis.activeMs, hours.get(HOUR3)?.revision]).toEqual([MINUTE, 1]);
    expect(hours.has(HOUR4)).toBe(false); // nothing happened in it
    const revisions = await mes.db.selectFrom('alarms.kpi_revision').selectAll().execute();
    expect(revisions.map((r) => [r.scope, r.hour.toISOString(), r.revision])).toEqual([
      ['equipment:cnc-01', HOUR3, 1],
    ]);
  });

  it('never revises hours a snapshot closes while the jump that applies it makes them final (review P1)', async () => {
    const mes = await setup();
    // The clear at seq 3 is lost; final through stays at 03:05 while facts up to 05:05 arrive.
    await mes.send(state(E1, 1, t(0)), raise(E1, 2, t(5)), state(E1, 4, t(30), 'Stopped'));
    await mes.retained(snapshot(E1, 4, t(30), []));
    await mes.send(state(E1, 5, t(125)));
    expect([...(await equipmentHours(mes.alarms)).values()].some((b) => b.final)).toBe(false);
    // Writing the gap off settles through 05:05 and applies the snapshot at once: 03:00 and 04:00
    // become final with the lost clear in them, never having been final without it.
    await writeOff(mes);
    expect(await occurrences(mes.alarms)).toEqual([[2, CP, 'fact', t(5), t(30), 'lost']]);
    const hours = await equipmentHours(mes.alarms);
    expect([hours.get(HOUR3)?.final, hours.get(HOUR3)?.revision]).toEqual([true, 0]);
    expect(await revisions(mes.db)).toEqual([]);
  });

  it('publishes the new final through only after the snapshot it applies commits, also after a failed write', async () => {
    const mes = await setup();
    await mes.send(state(E1, 1, t(0)), raise(E1, 2, t(5)), state(E1, 4, t(30), 'Stopped'));
    await mes.retained(snapshot(E1, 4, t(30), []));
    await mes.send(state(E1, 5, t(125)));
    // Every write of an occurrence fails: the window between learning and committing stays open.
    await sql`CREATE FUNCTION alarms.refuse() RETURNS trigger LANGUAGE plpgsql AS
      $$BEGIN RAISE EXCEPTION 'injected failure'; END$$`.execute(mes.db);
    await sql`CREATE TRIGGER refuse BEFORE INSERT OR UPDATE ON alarms.alarm_occurrence
      FOR EACH ROW EXECUTE FUNCTION alarms.refuse()`.execute(mes.db);
    await writeOff(mes);
    // A reader in the window sees the old bounds with the old rows: nothing final yet.
    expect(await occurrences(mes.alarms)).toEqual([[2, CP, 'fact', t(5), null, null]]);
    expect([...(await equipmentHours(mes.alarms)).values()].some((b) => b.final)).toBe(false);
    await sql`DROP TRIGGER refuse ON alarms.alarm_occurrence`.execute(mes.db);
    // The next notice retries the derivation, judged by the bounds still published, then publishes.
    await mes.send(state(E1, 6, t(130)));
    expect(await occurrences(mes.alarms)).toEqual([[2, CP, 'fact', t(5), t(30), 'lost']]);
    const hours = await equipmentHours(mes.alarms);
    expect([hours.get(HOUR3)?.final, hours.get(HOUR3)?.revision]).toEqual([true, 0]);
    expect(await revisions(mes.db)).toEqual([]);
  });

  it('keeps an epoch open for readers until its close commits', async () => {
    const mes = await setup();
    await mes.send(state(E1, 1, t(0)), raise(E1, 2, t(10)), state(E1, 3, t(40), 'Stopped'));
    await sql`CREATE FUNCTION alarms.refuse() RETURNS trigger LANGUAGE plpgsql AS
      $$BEGIN RAISE EXCEPTION 'injected failure'; END$$`.execute(mes.db);
    await sql`CREATE TRIGGER refuse BEFORE INSERT OR UPDATE ON alarms.alarm_occurrence
      FOR EACH ROW EXECUTE FUNCTION alarms.refuse()`.execute(mes.db);
    await mes.send(state(E2, 1, t(0)));
    // The close failed: E1 is not final everywhere, its alarm still open.
    expect(await occurrences(mes.alarms, E1)).toEqual([[2, CP, 'fact', t(10), null, null]]);
    expect((await equipmentHours(mes.alarms, E1)).get(HOUR3)?.final).toBe(false);
    await sql`DROP TRIGGER refuse ON alarms.alarm_occurrence`.execute(mes.db);
    await mes.send(state(E2, 2, t(1)));
    expect(await occurrences(mes.alarms, E1)).toEqual([
      [2, CP, 'fact', t(10), t(40), 'epoch-ended'],
    ]);
    expect((await equipmentHours(mes.alarms, E1)).get(HOUR3)?.final).toBe(true);
  });

  it('revises every final hour a late raise can change: its windows and its active span', async () => {
    const mes = await setup();
    // A raise at 03:55 (seq 2) is lost in a gap; its clear at 04:20 arrives with nothing open.
    await mes.send(state(E1, 1, t(0)), clear(E1, 3, t(80), SO), state(E1, 4, t(190), 'Stopped'));
    await writeOff(mes);
    expect(await occurrences(mes.alarms)).toEqual([]);
    // Nothing happened in any hour yet: only the hour in progress (06:10) is listed.
    expect([...(await equipmentHours(mes.alarms)).keys()]).toEqual([HOUR6]);
    await mes.send(raise(E1, 2, t(55), SO));
    expect(await occurrences(mes.alarms)).toEqual([[2, SO, 'fact', t(55), t(80), 'cleared']]);
    // [03:55, 04:05] (windows, floods, chattering) and [03:55, 04:20] (active): 03:00 and 04:00,
    // not 05:00, which is final too (final through 06:10).
    const revisions = await mes.db
      .selectFrom('alarms.kpi_revision')
      .selectAll()
      .orderBy('hour')
      .execute();
    expect(revisions.map((r) => [r.scope, r.hour.toISOString(), r.revision])).toEqual([
      ['equipment:cnc-01', HOUR3, 1],
      ['equipment:cnc-01', HOUR4, 1],
    ]);
    const hours = await equipmentHours(mes.alarms);
    expect([...hours.values()].map((b) => [b.key, b.final, b.revision])).toEqual([
      [HOUR3, true, 1],
      [HOUR4, true, 1],
      [HOUR6, false, 0],
    ]);
    const shift = await mes.alarms.kpis({
      scope: 'equipment',
      id: 'cnc-01',
      bucket: 'shift',
      from: new Date(t(0)),
      to: new Date(t(60)),
    });
    expect(shift.map((b) => [b.key, b.revision])).toEqual([['2026-10-12/A', 1]]);
    expect(hours.get(HOUR5)).toBeUndefined();
  });

  it('revises every final hour a late clear spanning three hours changes (reference case 19)', async () => {
    const mes = await setup();
    // SPINDLE-OVERLOAD raised 10:40, its clear at 12:20 (seq 3) lost in a gap; final through 14:05.
    await mes.send(state(E1, 1, t(420)), raise(E1, 2, t(460), SO), state(E1, 4, t(665)));
    await writeOff(mes);
    await mes.send(clear(E1, 3, t(560), SO));
    const revisions = await mes.db
      .selectFrom('alarms.kpi_revision')
      .selectAll()
      .orderBy('hour')
      .execute();
    // 10, 11, 12 (raise to clear) and 13, which showed it active; 14:00 is not final yet.
    expect(revisions.map((r) => [r.scope, r.hour.toISOString().slice(11, 16), r.revision])).toEqual(
      ['10:00', '11:00', '12:00', '13:00'].map((hour) => ['equipment:cnc-01', hour, 1]),
    );
  });

  it('revises the hours of the late fact’s equipment, its position and the plant, not the others', async () => {
    const mes = await setup();
    const machines = plant.plant.areas.flatMap((a) =>
      a.workCenters.flatMap((wc) => wc.equipment.map((e) => e.id)),
    );
    for (const machine of machines.filter((m) => m !== 'cnc-01')) {
      await mes.send(
        feed.state(machine, E1, 1, t(0), 'Running', null),
        feed.state(machine, E1, 2, t(130), 'Running', null),
      );
    }
    await mes.send(state(E1, 1, t(0)), state(E1, 3, t(130)));
    await writeOff(mes);
    const plantHours = async () =>
      (
        await mes.alarms.kpis({
          scope: 'plant',
          id: 'plant',
          bucket: 'shift',
          from: new Date(t(0)),
          to: new Date(t(60)),
        })
      ).map((b) => [b.key, b.final, b.revision, b.incidents]);
    // Final through 05:10 everywhere: 03:00 and 04:00 final; the shift is not over.
    expect(await plantHours()).toEqual([['2026-10-12/A', false, 0, 1]]);
    await mes.send(raise(E1, 2, t(30)));
    const revisions = await mes.db
      .selectFrom('alarms.kpi_revision')
      .select(['scope', 'hour', 'revision'])
      .orderBy('scope')
      .orderBy('hour')
      .execute();
    // Raised 03:30 and still open: [03:30, 03:40] and its active span to the plant clock.
    expect(revisions.map((r) => [r.scope, r.hour.toISOString(), r.revision])).toEqual(
      ['equipment:cnc-01', 'plant', 'position:cell-m1'].flatMap((scope) => [
        [scope, HOUR3, 1],
        [scope, HOUR4, 1],
      ]),
    );
    expect(await plantHours()).toEqual([['2026-10-12/A', false, 1, 1]]);
  });

  it('a fact arriving in order never revises, even inside a flood that began in a final hour', async () => {
    const mes = await setup();
    const deliveries: Delivery[] = [state(E1, 1, t(0))];
    let seq = 1;
    // 13 raises 50 s apart from 03:51:00, each cleared 500 ms later (fleeting): the 11th
    // (03:59:20) starts a flood; 03:00 is final once 04:00:10 is known, and the raise at 04:01:00
    // joins the running episode, whose revision span reaches back into 03:00.
    for (let i = 0; i < 13; i++) {
      const at = t(51) + i * 50_000;
      deliveries.push(raise(E1, ++seq, at), clear(E1, ++seq, at + 500));
    }
    deliveries.push(state(E1, seq + 1, t(130)));
    await mes.send(...deliveries);
    const floods = await mes.alarms.floods({
      scope: 'equipment',
      id: 'cnc-01',
      from: new Date(t(0)),
      to: new Date(t(180)),
    });
    expect(floods.episodes.map((e) => [e.startAt, e.endAt, e.peak, e.raises])).toEqual([
      [t(59, 20_000), t(62, 40_000), 12, 3],
    ]);
    const hours = await equipmentHours(mes.alarms);
    expect([...hours.values()].map((b) => [b.key, b.final, b.revision])).toEqual([
      [HOUR3, true, 0],
      [HOUR4, true, 0],
      [HOUR5, false, 0], // in progress at the plant clock (05:10)
    ]);
    expect(hours.get(HOUR3)?.kpis).toMatchObject({ raises: 11, fleeting: 11, floodWindows: 1 });
    expect(await mes.db.selectFrom('alarms.kpi_revision').selectAll().execute()).toEqual([]);
  });
});

describe('alarm catch-up at start-up (#142)', () => {
  it('derives what changed while it was stopped, and nothing else', async () => {
    const mes = await setup();
    await mes.send(state(E1, 1, t(0)), raise(E1, 2, t(10)));
    await mes.alarms.stop();
    await mes.send(clear(E1, 3, t(20)), state(E1, 4, t(30)));
    const restarted = await mes.startAlarms();
    expect(await occurrences(restarted)).toEqual([[2, CP, 'fact', t(10), t(20), 'cleared']]);
    const before = await storedRows(mes.db);
    await restarted.stop();
    const again = await mes.startAlarms();
    expect(await storedRows(mes.db)).toEqual(before);
    expect((await equipmentHours(again)).get(HOUR3)?.kpis.activeMs).toBe(10 * MINUTE);
  });
});

describe('alarm revisions across a restart (#142, review P3)', () => {
  it('a gap filled while stopped revises nothing that was never final', async () => {
    const mes = await setup();
    // seq 3 is missing: final through stays at 03:10 though facts reach 05:05.
    await mes.send(state(E1, 1, t(0)), raise(E1, 2, t(10)), state(E1, 4, t(125)));
    await mes.alarms.stop();
    await mes.send(clear(E1, 3, t(20)));
    const restarted = await mes.startAlarms();
    expect(await occurrences(restarted)).toEqual([[2, CP, 'fact', t(10), t(20), 'cleared']]);
    const hours = await equipmentHours(restarted);
    expect([hours.get(HOUR3)?.final, hours.get(HOUR3)?.revision]).toEqual([true, 0]);
    expect(await revisions(mes.db)).toEqual([]);
  });

  it('a late fact found at start-up revises an hour reported final before the restart', async () => {
    const mes = await setup();
    // seq 3 (the clear) is written off; final through 04:00:30 makes 03:00 final (end + 1 s).
    await mes.send(state(E1, 1, t(0)), raise(E1, 2, t(10)), state(E1, 4, t(60, 400)));
    await writeOff(mes);
    await mes.send(state(E1, 5, t(60, 30_000)));
    expect((await equipmentHours(mes.alarms)).get(HOUR3)?.final).toBe(true);
    await mes.alarms.stop();
    await mes.send(clear(E1, 3, t(20)));
    const restarted = await mes.startAlarms();
    expect(await occurrences(restarted)).toEqual([[2, CP, 'fact', t(10), t(20), 'cleared']]);
    expect(await revisions(mes.db)).toEqual([['equipment:cnc-01', HOUR3, 1]]);
    expect((await equipmentHours(restarted)).get(HOUR3)?.revision).toBe(1);
  });
});

describe('alarm API and push (#142)', () => {
  let app: FastifyInstance;
  let mes: Mes;
  let base: string;

  const get = async (url: string) => {
    const response = await app.inject({ url: `/api/v1${url}` });
    return { status: response.statusCode, body: response.json<unknown>() };
  };

  beforeAll(async () => {
    mes = await setup();
    cleanup.splice(0); // kept for the whole describe; closed in its afterAll
    const http = await buildMesHttp({ ready: () => Promise.resolve(true), push: { oeeMs: 100 } });
    app = http.app;
    const oee = new Oee({
      equipment: mes.equipment,
      ingest: mes.ingest,
      masterData: mes.masterData,
      shiftPattern: plant.shifts,
      config: plant.oee,
      idealCycleMs: {},
    });
    await oee.start();
    await http.realtime.attach({
      masterData: mes.masterData,
      equipment: mes.equipment,
      ingest: mes.ingest,
      oee,
      coding: new DowntimeCoding({
        db: mes.db,
        equipment: mes.equipment,
        codable: () => Promise.resolve(true),
      }),
      alarms: mes.alarms,
    });
    base = (await app.listen({ host: '127.0.0.1', port: 0 })).replace('http', 'ws');
    await mes.send(
      state(E1, 1, t(0)),
      raise(E1, 2, t(10)),
      clear(E1, 3, t(12)),
      raise(E1, 4, t(20), SO),
      state(E1, 5, t(70), 'Stopped'),
    );
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await mes.alarms.stop();
    await mes.equipment.stop();
    await mes.db.destroy();
  });

  it('lists active and ended occurrences with filters and pages, and answers bad requests with problem details', async () => {
    const active = await get('/alarms');
    expect(active.status).toBe(200);
    const list = alarmListSchema.parse(active.body);
    // A clear does not acknowledge (#143): the cleared one stays in the active list.
    expect(list.alarms.map((a) => [a.id, a.active, a.priority, a.state])).toEqual([
      [`cnc-01~${String(E1)}~4`, true, 'high', 'unacked-active'],
      [`cnc-01~${String(E1)}~2`, false, 'medium', 'unacked-cleared'],
    ]);
    // Acknowledged, it is closed and moves to the history.
    await mes.alarms.acknowledge([`cnc-01~${String(E1)}~2`], { actor: 'test' });
    const after = alarmListSchema.parse((await get('/alarms')).body);
    expect(after.alarms.map((a) => a.seq)).toEqual([4]);
    const range = `from=${iso(t(0))}&to=${iso(t(60))}`;
    const history = alarmListSchema.parse((await get(`/alarms?view=history&${range}`)).body);
    expect(history.alarms.map((a) => [a.seq, a.endReason, a.endedAt, a.state])).toEqual([
      [2, 'cleared', iso(t(12)), 'closed'],
    ]);
    expect(history.next).toBeNull();
    const filtered = alarmListSchema.parse(
      (await get(`/alarms?position=cell-m1&priority=medium&view=history&${range}`)).body,
    );
    expect(filtered.alarms.map((a) => a.seq)).toEqual([2]);
    const paged = alarmListSchema.parse(
      (await get(`/alarms?view=history&limit=1&${range}&equipment=cnc-01`)).body,
    );
    expect(paged.next).toBeNull();
    for (const [url, status] of [
      ['/alarms?view=history', 400],
      [`/alarms?view=history&from=${iso(t(0))}&to=${iso(t(0) + 8 * 24 * 60 * MINUTE)}`, 400],
      ['/alarms?position=nowhere', 404],
      ['/alarms?equipment=nowhere', 404],
      [
        '/alarms/kpi?scope=position&bucket=hour&from=2026-10-12T00:00:00Z&to=2026-10-12T06:00:00Z',
        400,
      ],
      [
        '/alarms/kpi?scope=position&id=nowhere&bucket=hour&from=2026-10-12T00:00:00Z&to=2026-10-12T06:00:00Z',
        404,
      ],
      ['/alarms/not-an-id', 400],
      [`/alarms/cnc-01~${String(E1)}~99`, 404],
      [`/alarms/cnc-01~${String(E1)}~99/history`, 404],
    ] as const) {
      const answer = await get(url);
      expect([url, answer.status]).toEqual([url, status]);
      problemSchema.parse(answer.body);
    }
  });

  it('pages the list by cursor', async () => {
    await mes.send(raise(E1, 6, t(71)), raise(E1, 7, t(72), 'WORKPIECE-PROBE'));
    const range = `from=${iso(t(0))}&to=${iso(t(120))}`;
    const first = alarmListSchema.parse((await get(`/alarms?limit=2&${range}`)).body);
    expect(first.alarms.map((a) => a.seq)).toEqual([7, 6]);
    expect(first.next).not.toBeNull();
    const second = alarmListSchema.parse(
      (await get(`/alarms?limit=2&${range}&cursor=${first.next ?? ''}`)).body,
    );
    expect(second.alarms.map((a) => a.seq)).toEqual([4]);
    expect(second.next).toBeNull();
    // A code without a definition takes its priority from its severity.
    expect(first.alarms[0]).toMatchObject({ code: 'WORKPIECE-PROBE', defined: false, text: null });
  });

  it('returns an occurrence with its definition and its history', async () => {
    const id = `cnc-01~${String(E1)}~2`;
    const detail = alarmDetailSchema.parse((await get(`/alarms/${id}`)).body);
    expect(detail.occurrence).toMatchObject({ id, code: CP, endReason: 'cleared', final: true });
    expect(detail.definition?.text.length).toBeGreaterThan(0);
    const history = alarmHistorySchema.parse((await get(`/alarms/${id}/history`)).body);
    const audit = {
      actor: null,
      authenticated: null,
      recordedAt: null,
      requestId: null,
      auditId: null,
      detail: null,
    };
    expect(history.entries.slice(0, 2)).toEqual([
      {
        source: 'fact',
        transition: 'raised',
        at: iso(t(10)),
        seq: 2,
        receivedAt: '2026-10-15T10:00:00.000Z',
        protocol: 'opcua',
        ...audit,
      },
      {
        source: 'fact',
        transition: 'cleared',
        at: iso(t(12)),
        seq: 3,
        receivedAt: '2026-10-15T10:00:00.000Z',
        protocol: 'opcua',
        ...audit,
      },
    ]);
    // The acknowledgement of the first test, at the plant clock (the last fact, 04:10).
    expect(history.entries.slice(2)).toMatchObject([
      { source: 'audit', transition: 'ack', at: iso(t(70)), actor: 'test', authenticated: false },
    ]);
  });

  it('returns KPIs per hour and shift, floods, bad actors and the scopes', async () => {
    const range = `from=${iso(t(0))}&to=${iso(t(120))}`;
    const hours = alarmKpiListSchema.parse(
      (await get(`/alarms/kpi?scope=equipment&id=cnc-01&bucket=hour&${range}`)).body,
    );
    const hour = hours.buckets.find((b) => b.key === HOUR3);
    expect(hour).toMatchObject({
      raises: 2,
      averageRate: { fraction: '1/3', decimal: '0.3333' },
      activeMs: 2 * MINUTE + 40 * MINUTE,
      activeAtEnd: 1,
      final: true,
      revision: 0,
    });
    const shifts = alarmKpiListSchema.parse(
      (await get(`/alarms/kpi?scope=position&id=cell-m1&bucket=shift&${range}`)).body,
    );
    expect(shifts.buckets.map((b) => [b.key, b.from, b.to])).toEqual([
      ['2026-10-12/A', iso(t(0)), iso(t(8 * 60))],
    ]);
    const floods = floodListSchema.parse((await get(`/alarms/floods?scope=plant&${range}`)).body);
    expect(floods.episodes).toEqual([]);
    const actors = badActorListSchema.parse(
      (await get(`/alarms/bad-actors?scope=equipment&id=cnc-01&${range}&limit=2`)).body,
    );
    // COOLANT-PRESSURE twice; then SPINDLE-OVERLOAD (active 52 min) before WORKPIECE-PROBE.
    expect(actors.actors.map((a) => [a.code, a.raises, a.share.fraction])).toEqual([
      [CP, 2, '1/2'],
      [SO, 1, '1/4'],
    ]);
    const scopes = alarmScopesSchema.parse((await get('/alarms/scopes')).body);
    expect(scopes.scopes.slice(0, 3).map((s) => [s.scope, s.id])).toEqual([
      ['plant', 'plant'],
      ['position', 'cell-m1'],
      ['position', 'line-a1'],
    ]);
  });

  it('pushes occurrence upserts on `alarms` and paced KPI deltas on `alarm-kpi:<scope>`', async () => {
    const socket = new WebSocket(`${base}${WS_PATH}`);
    const messages: ServerMessage[] = [];
    socket.addEventListener('message', (event) => {
      messages.push(serverMessageSchema.parse(JSON.parse(String(event.data))));
    });
    await new Promise((resolve) => {
      socket.addEventListener('open', resolve, { once: true });
    });
    const until = async (predicate: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const found = messages.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`not received: ${JSON.stringify(messages)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'alarms' }));
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'alarm-kpi:equipment:cnc-01' }));
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'alarm-kpi:position:nowhere' }));
    const snap = await until((m) => m.type === 'snapshot' && m.topic.startsWith('alarm-kpi:'));
    if (snap.type !== 'snapshot' || !('floods' in snap)) throw new Error('no alarm KPI snapshot');
    const before = snap.hour?.raises ?? 0;
    await until((m) => m.type === 'error' && m.code === 'unknown-equipment');
    await mes.send(raise(E1, 8, t(73), 'TOOL-WEAR'));
    const upsert = await until((m) => m.type === 'alarm' && m.occurrence.seq === 8);
    expect(upsert).toMatchObject({ event: 'raised', occurrence: { code: 'TOOL-WEAR' } });
    const delta = await until(
      (m) => m.type === 'alarm-kpi' && (m.hour?.raises ?? 0) === before + 1,
    );
    expect(delta).toMatchObject({ topic: 'alarm-kpi:equipment:cnc-01' });
    socket.close();
  });
});
