import { resolve } from 'node:path';
import {
  alarmSnapshotTopic,
  alarmTopic,
  stateTopic,
  type Alarm,
  type AlarmSnapshot,
} from '@shopfloor/contracts';
import { sql, type Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../db/database.ts';
import { migrate } from '../../db/migrate.ts';
import { startDatabase } from '../../testing.ts';
import { Ingest, baselineState, resolveAlarmBaseline, type IngestNotice } from './index.ts';

/**
 * Ingest for alarms (#141, ADR-0017 amendment): alarm facts and their notices, retained alarm
 * deliveries as anchors, the gateway's alarm snapshots, and the old-epoch rule. Messages go through
 * `Ingest.deliver`, the store path without a broker, with the same classification and tables.
 */

const MIGRATIONS = resolve(import.meta.dirname, '../../../../../db/migrations');
const GW_EPOCH = 1_760_100_000;
const OLD = 1_760_000_000;
const NEW = 1_760_050_000;
const PATH = { area: 'machining', workCenter: 'cell-m1', equipment: 'cnc-01' } as const;

let container: StartedTestContainer;
let databaseUrl: string;
let testNumber = 0;
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  const database = await startDatabase();
  container = database.container;
  databaseUrl = database.url;
}, 180_000);

afterAll(async () => {
  await container.stop();
});

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Per test: its own database and an ingest that is never connected to a broker. */
async function setup(): Promise<{
  db: Kysely<Database>;
  ingest: Ingest;
  notices: IngestNotice[];
  clock: { now: number };
}> {
  testNumber++;
  const admin = createDatabase(databaseUrl, 1);
  await sql.raw(`CREATE DATABASE alarms_${String(testNumber)}`).execute(admin);
  await admin.destroy();
  const db = createDatabase(
    databaseUrl.replace(/\/shopfloor$/, `/alarms_${String(testNumber)}`),
    3,
  );
  cleanup.push(() => db.destroy());
  await migrate(db, MIGRATIONS);
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
  const notices: IngestNotice[] = [];
  ingest.onStored((notice) => {
    notices.push(notice);
  });
  return { db, ingest, notices, clock };
}

const at = (seq: number): string => new Date(Date.UTC(2026, 9, 12, 3) + seq * 1000).toISOString();

function alarm(
  epoch: number,
  seq: number,
  code: string,
  transition: 'active' | 'cleared',
  severity = 700,
): Alarm {
  return {
    schema: 'uns.alarms/1',
    scope: 'device',
    epoch,
    seq,
    sourceTime: at(seq),
    receivedAt: '2026-10-15T10:00:00.000Z',
    quality: 'good',
    source: { id: PATH.equipment, protocol: 'opcua' },
    value: { code, transition, severity },
  };
}

function alarmSnapshot(
  deviceEpoch: number,
  asOfSeq: number,
  active: string[],
  seq = 1,
): AlarmSnapshot {
  return {
    schema: 'uns.alarm-snapshot/1',
    kind: 'snapshot',
    scope: 'topic',
    epoch: GW_EPOCH,
    seq,
    deviceEpoch,
    asOfSeq,
    sourceTime: at(asOfSeq),
    receivedAt: '2026-10-15T10:00:00.000Z',
    quality: 'good',
    source: { id: PATH.equipment, protocol: 'opcua' },
    value: { active },
  };
}

const stateEvent = (epoch: number, seq: number) => ({
  schema: 'uns.state.current/1' as const,
  kind: 'event' as const,
  scope: 'device' as const,
  epoch,
  seq,
  sourceTime: at(seq),
  receivedAt: '2026-10-15T10:00:00.000Z',
  quality: 'good' as const,
  source: { id: PATH.equipment, protocol: 'opcua' as const },
  value: { state: 'Running' as const, cause: null },
});

const deliverAlarm = (ingest: Ingest, message: Alarm, retained = false) =>
  ingest.deliver(alarmTopic(PATH, message.value.code), JSON.stringify(message), retained);

const deliverSnapshot = (ingest: Ingest, message: AlarmSnapshot, retained = false) =>
  ingest.deliver(alarmSnapshotTopic(PATH), JSON.stringify(message), retained);

const deliverState = (ingest: Ingest, epoch: number, seq: number, retained = false) =>
  ingest.deliver(stateTopic(PATH), JSON.stringify(stateEvent(epoch, seq)), retained);

const cursors = (db: Kysely<Database>) =>
  db
    .selectFrom('ingest.source_cursor')
    .select(['stream', 'epoch', 'seen'])
    .orderBy('stream')
    .execute();

describe('ingest: alarm facts (#141)', () => {
  it('stores alarm transitions as facts, sends an alarm notice after the sample, and reads them back by seq', async () => {
    const { ingest, notices } = await setup();
    await deliverAlarm(ingest, alarm(NEW, 1, 'SPINDLE-OVERLOAD', 'active', 800));
    await deliverState(ingest, NEW, 2);
    await deliverAlarm(ingest, alarm(NEW, 3, 'COOLANT-PRESSURE', 'active'));
    await deliverAlarm(ingest, alarm(NEW, 4, 'SPINDLE-OVERLOAD', 'cleared', 800));
    await deliverAlarm(ingest, alarm(NEW, 4, 'SPINDLE-OVERLOAD', 'cleared', 800)); // duplicate

    const alarms = notices.filter((n) => n.type === 'alarm');
    expect(alarms).toEqual([
      {
        type: 'alarm',
        fact: {
          equipment: 'cnc-01',
          epoch: NEW,
          seq: 1,
          sourceTime: new Date(at(1)),
          code: 'SPINDLE-OVERLOAD',
          transition: 'active',
          severity: 800,
          quality: 'good',
        },
        settledSeq: 1,
      },
      expect.objectContaining({ fact: expect.objectContaining({ seq: 3 }) as unknown }),
      expect.objectContaining({ fact: expect.objectContaining({ seq: 4 }) as unknown }),
    ]);
    // Each alarm notice right after its fact's sample.
    const types = notices.map((n) => n.type).filter((t) => t !== 'epoch');
    expect(types).toEqual(['sample', 'alarm', 'state', 'sample', 'alarm', 'sample', 'alarm']);

    const facts = await ingest.alarmFacts('cnc-01', NEW);
    expect(facts.map((f) => [f.seq, f.code, f.transition])).toEqual([
      [1, 'SPINDLE-OVERLOAD', 'active'],
      [3, 'COOLANT-PRESSURE', 'active'],
      [4, 'SPINDLE-OVERLOAD', 'cleared'],
    ]);
    expect(
      (await ingest.alarmFacts('cnc-01', NEW, { code: 'SPINDLE-OVERLOAD' })).map((f) => f.seq),
    ).toEqual([1, 4]);
    expect(
      (await ingest.alarmFacts('cnc-01', NEW, { fromSeq: 2, toSeq: 3 })).map((f) => f.seq),
    ).toEqual([3]);
    expect(await ingest.alarmFacts('cnc-01', OLD)).toEqual([]);
    expect(await ingest.alarmFactCounts()).toEqual([{ equipment: 'cnc-01', epoch: NEW, facts: 3 }]);
  });
});

describe('ingest: alarm anchors from retained deliveries (#141)', () => {
  it('stores a retained alarm as an anchor (highest seq wins), never as a fact, a duplicate or a gap', async () => {
    const { db, ingest, notices, clock } = await setup();
    await deliverAlarm(ingest, alarm(NEW, 5, 'SPINDLE-OVERLOAD', 'active'), true);
    await deliverAlarm(ingest, alarm(NEW, 3, 'SPINDLE-OVERLOAD', 'cleared'), true); // older
    await deliverAlarm(ingest, alarm(NEW, 5, 'SPINDLE-OVERLOAD', 'active'), true); // again
    expect(ingest.count('anchor')).toBe(3);
    expect(notices).toEqual([
      {
        type: 'alarm-anchor',
        anchor: {
          equipment: 'cnc-01',
          epoch: NEW,
          code: 'SPINDLE-OVERLOAD',
          seq: 5,
          transition: 'active',
          severity: 700,
          sourceTime: new Date(at(5)),
          stale: false,
        },
      },
    ]);
    await deliverAlarm(ingest, alarm(NEW, 8, 'SPINDLE-OVERLOAD', 'cleared'), true); // newer
    expect(notices.at(-1)).toMatchObject({
      type: 'alarm-anchor',
      anchor: { seq: 8, transition: 'cleared' },
    });
    expect(await ingest.alarmAnchors()).toEqual([
      expect.objectContaining({ code: 'SPINDLE-OVERLOAD', seq: 8, transition: 'cleared' }),
    ]);
    expect(await db.selectFrom('ingest.equipment_event').selectAll().execute()).toEqual([]);
    expect(await cursors(db)).toEqual([]);

    // The live stream starts at 10: the anchors' numbers make neither a gap nor a duplicate, and
    // the anchor's own fact, delivered live later, is a fact like any other.
    await deliverAlarm(ingest, alarm(NEW, 10, 'SPINDLE-OVERLOAD', 'active'));
    await deliverAlarm(ingest, alarm(NEW, 11, 'SPINDLE-OVERLOAD', 'cleared'));
    await deliverAlarm(ingest, alarm(NEW, 8, 'SPINDLE-OVERLOAD', 'cleared'));
    expect(ingest.count('stored')).toBe(3);
    expect(ingest.count('duplicate')).toBe(0);
    expect(await cursors(db)).toEqual([
      {
        stream: 'device:cnc-01',
        epoch: NEW,
        seen: [
          [8, 8],
          [10, 11],
        ],
      },
    ]);
    // The hole at 9 is the facts' own: the anchors added none.
    clock.now += 10_000;
    await ingest.sweep();
    clock.now += 10_000;
    expect(await ingest.sweep()).toBe(1);
    expect(
      await db.selectFrom('ingest.data_quality_incident').select(['seq_from', 'seq_to']).execute(),
    ).toEqual([{ seq_from: 9, seq_to: 9 }]);
  });
});

describe('ingest: alarm snapshots from the gateway (#141)', () => {
  it('keeps the highest asOfSeq per device epoch and never touches dedup, gaps or settledness', async () => {
    const { db, ingest, notices, clock } = await setup();
    for (const seq of [1, 2, 3]) await deliverState(ingest, NEW, seq);
    const before = await cursors(db);

    await deliverSnapshot(ingest, alarmSnapshot(NEW, 50, ['SPINDLE-OVERLOAD', 'COOLANT-PRESSURE']));
    await deliverSnapshot(ingest, alarmSnapshot(NEW, 40, [], 2)); // older content, newer topic seq
    await deliverSnapshot(ingest, alarmSnapshot(NEW, 50, ['SPINDLE-OVERLOAD'], 3), true); // equal
    expect(notices.filter((n) => n.type === 'alarm-snapshot')).toEqual([
      {
        type: 'alarm-snapshot',
        snapshot: {
          equipment: 'cnc-01',
          deviceEpoch: NEW,
          asOfSeq: 50,
          active: ['COOLANT-PRESSURE', 'SPINDLE-OVERLOAD'],
          sourceTime: new Date(at(50)),
          stale: false,
        },
      },
    ]);
    await deliverSnapshot(ingest, alarmSnapshot(NEW, 60, [], 4));
    expect(await ingest.alarmSnapshots()).toEqual([
      expect.objectContaining({ asOfSeq: 60, active: [] }),
    ]);

    // Neither the snapshot's asOfSeq (50, 60) nor its gateway seq is a number of any stream.
    expect(await cursors(db)).toEqual(before);
    expect(before).toEqual([{ stream: 'device:cnc-01', epoch: NEW, seen: [[1, 3]] }]);
    clock.now += 10_000;
    expect(await ingest.sweep()).toBe(0);
    expect((await ingest.settled('cnc-01', NEW)).settledSeq).toBe(3);
    expect(await db.selectFrom('ingest.data_quality_incident').selectAll().execute()).toEqual([]);
    expect(ingest.count('stored')).toBe(3);
    expect(ingest.count('duplicate')).toBe(0);
    // A later fact numbered below the snapshot's asOfSeq is a fact like any other.
    await deliverAlarm(ingest, alarm(NEW, 4, 'SPINDLE-OVERLOAD', 'cleared'));
    expect(ingest.count('stored')).toBe(4);
  });

  it('a snapshot that doesn\u2019t name a code says it was inactive at asOfSeq: a lost clear', async () => {
    const { ingest } = await setup();
    await deliverAlarm(ingest, alarm(NEW, 5, 'X', 'active')); // a fact; its clear at 6 is lost
    await deliverSnapshot(ingest, alarmSnapshot(NEW, 7, []));
    const [raise] = await ingest.alarmFacts('cnc-01', NEW, { code: 'X' });
    expect(raise).toMatchObject({ seq: 5, transition: 'active' });
    const baseline = await ingest.alarmBaseline('cnc-01');
    expect(baseline?.points).toEqual([]);
    expect(baseline?.snapshot).toEqual({ asOfSeq: 7, sourceTime: new Date(at(7)) });
    if (!baseline) throw new Error('no baseline');
    expect(baselineState(baseline, 'X')).toEqual({
      active: false,
      source: 'snapshot',
      seq: 7,
      sourceTime: new Date(at(7)),
    });
    // So X, raised at 5 < 7, is inactive at 7.
    expect((baselineState(baseline, 'X')?.seq ?? 0) > (raise?.seq ?? 0)).toBe(true);
  });

  it('resolves anchors against the snapshot by sequence: the higher number wins', async () => {
    const { ingest } = await setup();
    // X: raised at 5, the snapshot at 9 saw it inactive: its clear was lost.
    await deliverAlarm(ingest, alarm(NEW, 5, 'X', 'active'), true);
    // Y: cleared at 12, after the snapshot that saw it active.
    await deliverAlarm(ingest, alarm(NEW, 12, 'Y', 'cleared'), true);
    // W: raised at 9 itself, as the snapshot saw it: the anchor is kept (its time and severity).
    await deliverAlarm(ingest, alarm(NEW, 9, 'W', 'active', 300), true);
    // Z: active in the snapshot, its retained delivery never came.
    await deliverSnapshot(ingest, alarmSnapshot(NEW, 9, ['W', 'Y', 'Z']));
    const baseline = await ingest.alarmBaseline('cnc-01');
    expect(baseline?.epoch).toBe(NEW);
    expect(baseline?.points.map((p) => [p.code, p.active, p.source, p.seq, p.severity])).toEqual([
      ['W', true, 'anchor', 9, 300],
      ['X', false, 'snapshot', 9, 700],
      ['Y', false, 'anchor', 12, 700],
      ['Z', true, 'snapshot', 9, null],
    ]);
    // A later snapshot sees Y raised again and X still inactive; an anchor above it wins again.
    await deliverSnapshot(ingest, alarmSnapshot(NEW, 20, ['Y'], 2));
    await deliverAlarm(ingest, alarm(NEW, 21, 'X', 'active'), true);
    expect(
      (await ingest.alarmBaseline('cnc-01'))?.points.map((p) => [p.code, p.active, p.source]),
    ).toEqual([
      ['W', false, 'snapshot'],
      ['X', true, 'anchor'],
      ['Y', true, 'snapshot'],
    ]);
  });
});

describe('ingest: old epochs of alarm anchors and snapshots (#141)', () => {
  it('an MES started after a simulator restart lists none of the old run’s retained alarms as active', async () => {
    // The broker still holds the old run's retained alarms and snapshot, and the new run's state.
    // Retained deliveries come in any order: the new run's state first here.
    const { ingest, notices } = await setup();
    await deliverState(ingest, NEW, 3, true);
    await deliverAlarm(ingest, alarm(OLD, 40, 'SPINDLE-OVERLOAD', 'active'), true);
    await deliverSnapshot(ingest, alarmSnapshot(OLD, 41, ['SPINDLE-OVERLOAD']), true);
    expect(notices.filter((n) => n.type.startsWith('alarm'))).toEqual([
      {
        type: 'alarm-anchor',
        anchor: expect.objectContaining({ epoch: OLD, stale: true }) as unknown,
      },
      {
        type: 'alarm-snapshot',
        snapshot: expect.objectContaining({ deviceEpoch: OLD, stale: true }) as unknown,
      },
    ]);
    expect(await ingest.alarmAnchors()).toEqual([]);
    expect(await ingest.alarmSnapshots()).toEqual([]);
    expect(await ingest.alarmBaseline('cnc-01')).toBeUndefined();
    // Stored all the same, for diagnosis.
    expect(await ingest.alarmAnchors({ stale: true })).toEqual([
      expect.objectContaining({ epoch: OLD, code: 'SPINDLE-OVERLOAD', stale: true }),
    ]);
    expect(await ingest.alarmSnapshots({ stale: true })).toHaveLength(1);
  });

  it('the old run’s alarms first: they become stale when the new run’s first fact arrives', async () => {
    const { ingest, notices } = await setup();
    await deliverAlarm(ingest, alarm(OLD, 40, 'SPINDLE-OVERLOAD', 'active'), true);
    await deliverSnapshot(ingest, alarmSnapshot(OLD, 41, ['SPINDLE-OVERLOAD']), true);
    expect((await ingest.alarmBaseline('cnc-01'))?.points).toEqual([
      expect.objectContaining({ code: 'SPINDLE-OVERLOAD', active: true, source: 'snapshot' }),
    ]);
    await deliverState(ingest, NEW, 1);
    expect(notices.filter((n) => n.type === 'alarm-stale')).toEqual([
      {
        type: 'alarm-stale',
        equipment: 'cnc-01',
        epoch: NEW,
        anchors: [{ epoch: OLD, code: 'SPINDLE-OVERLOAD' }],
        snapshots: [OLD],
      },
    ]);
    expect(await ingest.alarmBaseline('cnc-01')).toBeUndefined();
    // A further fact of the same epoch changes nothing more.
    await deliverState(ingest, NEW, 2);
    expect(notices.filter((n) => n.type === 'alarm-stale')).toHaveLength(1);
  });

  it('a newer snapshot, anchor or state anchor makes older ones stale; an older one arrives stale', async () => {
    const { ingest, notices } = await setup();
    await deliverAlarm(ingest, alarm(OLD, 40, 'A', 'active'), true);
    // The new run's snapshot (a resync after the restart) is the first news of the new epoch.
    await deliverSnapshot(ingest, alarmSnapshot(NEW, 2, []));
    expect(notices.at(-2)).toEqual({
      type: 'alarm-stale',
      equipment: 'cnc-01',
      epoch: NEW,
      anchors: [{ epoch: OLD, code: 'A' }],
      snapshots: [],
    });
    await deliverAlarm(ingest, alarm(NEW, 1, 'B', 'active'), true);
    await deliverAlarm(ingest, alarm(OLD, 45, 'B', 'cleared'), true); // late, old run
    expect(notices.at(-1)).toMatchObject({
      type: 'alarm-anchor',
      anchor: { epoch: OLD, stale: true },
    });
    const baseline = await ingest.alarmBaseline('cnc-01');
    expect(baseline?.epoch).toBe(NEW);
    // B raised at 1, the snapshot at 2 saw it inactive.
    expect(baseline?.points.map((p) => [p.code, p.active, p.source])).toEqual([
      ['B', false, 'snapshot'],
    ]);

    // A state snapshot naming a newer device epoch makes everything above stale.
    const NEWER = NEW + 600;
    await ingest.deliver(
      stateTopic(PATH),
      JSON.stringify({
        ...stateEvent(GW_EPOCH, 9),
        kind: 'snapshot',
        scope: 'topic',
        deviceEpoch: NEWER,
      }),
    );
    expect(notices.filter((n) => n.type === 'alarm-stale').at(-1)).toEqual({
      type: 'alarm-stale',
      equipment: 'cnc-01',
      epoch: NEWER,
      anchors: [{ epoch: NEW, code: 'B' }],
      snapshots: [NEW],
    });
    expect(await ingest.alarmBaseline('cnc-01')).toBeUndefined();
  });
});

describe('resolveAlarmBaseline (#141)', () => {
  const t = new Date(at(0));
  const anchor = (code: string, seq: number, transition: 'active' | 'cleared') => ({
    code,
    seq,
    transition,
    severity: 700,
    sourceTime: t,
  });

  it('uses the anchors alone without a snapshot, and the snapshot alone without anchors', () => {
    expect(
      resolveAlarmBaseline([anchor('B', 2, 'cleared'), anchor('A', 1, 'active')], undefined).map(
        (p) => [p.code, p.active, p.source],
      ),
    ).toEqual([
      ['A', true, 'anchor'],
      ['B', false, 'anchor'],
    ]);
    expect(resolveAlarmBaseline([], { asOfSeq: 0, active: [], sourceTime: t })).toEqual([]);
    expect(resolveAlarmBaseline([], { asOfSeq: 3, active: ['A'], sourceTime: t })).toEqual([
      { code: 'A', active: true, source: 'snapshot', seq: 3, sourceTime: t, severity: null },
    ]);
  });

  it('lets the higher sequence win, and the anchor at equal numbers', () => {
    const snapshot = { asOfSeq: 10, active: ['B', 'C'], sourceTime: t };
    expect(
      resolveAlarmBaseline(
        [anchor('A', 9, 'active'), anchor('B', 11, 'cleared'), anchor('C', 10, 'active')],
        snapshot,
      ).map((p) => [p.code, p.active, p.source]),
    ).toEqual([
      ['A', false, 'snapshot'],
      ['B', false, 'anchor'],
      ['C', true, 'anchor'],
    ]);
  });
});
