import { resolve } from 'node:path';
import {
  alarmTopic,
  cycleTopic,
  stateTopic,
  sysTopic,
  telemetryTopic,
  type MachineState,
  type UnsMessage,
} from '@shopfloor/contracts';
import { TEST_PASSWORDS, startBroker } from '@shopfloor/test-kit/broker';
import { sql, type Kysely } from 'kysely';
import mqtt, { type MqttClient } from 'mqtt';
import pg from 'pg';
import { Registry } from 'prom-client';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../db/database.ts';
import { migrate } from '../../db/migrate.ts';
import { startDatabase } from '../../testing.ts';
import { Ingest, type IngestNotice, type IngestOptions } from './index.ts';

const MIGRATIONS = resolve(import.meta.dirname, '../../../../../db/migrations');
const GRACE_MS = 5_000;
const GW_EPOCH = 1_760_100_000;
const EPOCH = 1_760_000_000;

let databaseUrl: string;
let brokerUrl: string;
const containers: StartedTestContainer[] = [];
const cleanup: (() => Promise<unknown>)[] = [];
let publisher: MqttClient;
let testNumber = 0;

beforeAll(async () => {
  const [database, broker] = await Promise.all([startDatabase(), startBroker()]);
  containers.push(database.container, broker.container);
  databaseUrl = database.url;
  brokerUrl = broker.url;
  publisher = await mqtt.connectAsync(brokerUrl, {
    clientId: 'gw-01',
    username: 'gw-01',
    password: TEST_PASSWORDS['gw-01'],
    protocolVersion: 5,
  });
}, 180_000);

afterAll(async () => {
  await publisher.endAsync();
  await Promise.all(containers.map((c) => c.stop()));
});

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Per test: its own database, broker session and equipment, so tests never see each other. */
async function setup(): Promise<{
  db: Kysely<Database>;
  url: string;
  clientId: string;
  equipment: (name: string) => { area: string; workCenter: string; equipment: string };
  clock: { now: number };
  start: (options?: Partial<IngestOptions>) => Promise<Ingest>;
}> {
  testNumber++;
  const admin = createDatabase(databaseUrl, 1);
  await sql.raw(`CREATE DATABASE ingest_${String(testNumber)}`).execute(admin);
  await admin.destroy();
  const url = databaseUrl.replace(/\/shopfloor$/, `/ingest_${String(testNumber)}`);
  const db = createDatabase(url, 3);
  cleanup.push(() => db.destroy());
  await migrate(db, MIGRATIONS);
  const clientId = `mes-test-${String(testNumber)}`;
  const clock = { now: Date.parse('2026-10-15T10:00:00Z') };
  const start = async (options: Partial<IngestOptions> = {}): Promise<Ingest> => {
    const ingest = new Ingest({
      db,
      url: brokerUrl,
      username: 'mes',
      password: TEST_PASSWORDS.mes,
      clientId,
      gapGraceMs: GRACE_MS,
      sweepIntervalMs: 0,
      reconnectPeriodMs: 200,
      now: () => clock.now,
      ...options,
    });
    cleanup.push(() => ingest.stop());
    await ingest.start();
    await ingest.waitSubscribed();
    return ingest;
  };
  return {
    db,
    url,
    clientId,
    equipment: (name) => ({
      area: 'machining',
      workCenter: 'cell-t',
      equipment: `t${String(testNumber)}-${name}`,
    }),
    clock,
    start,
  };
}

const sourceTime = (seq: number): string =>
  new Date(Date.UTC(2026, 9, 12, 3) + seq * 1000).toISOString();

function identity(id: string, epoch: number, seq: number) {
  return {
    epoch,
    seq,
    sourceTime: sourceTime(seq),
    receivedAt: '2026-10-15T10:00:00.000Z',
    quality: 'good' as const,
    source: { id, protocol: 'opcua' as const },
  };
}

function stateEvent(id: string, epoch: number, seq: number, state: MachineState = 'Running') {
  return {
    schema: 'uns.state.current/1' as const,
    kind: 'event' as const,
    scope: 'device' as const,
    ...identity(id, epoch, seq),
    value: { state, cause: state === 'Down' ? 'SPINDLE-FAULT' : null },
  };
}

/** A snapshot; without `deviceEpoch` it is one from a gateway older than contract 1.1. */
function snapshot(id: string, seq: number, state: MachineState, deviceEpoch?: number) {
  return {
    ...stateEvent(id, GW_EPOCH, seq, state),
    kind: 'snapshot' as const,
    scope: 'topic' as const,
    ...(deviceEpoch === undefined ? {} : { deviceEpoch }),
  };
}

async function publish(topic: string, message: UnsMessage | string, retain = false): Promise<void> {
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  await publisher.publishAsync(topic, payload, { qos: 1, retain });
}

async function waitFor(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (const deadline = Date.now() + 20_000; !(await condition());) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const handled = (ingest: Ingest): number =>
  (['stored', 'duplicate', 'rejected', 'anchor', 'status', 'retained'] as const).reduce(
    (sum, outcome) => sum + ingest.count(outcome),
    0,
  );

async function seqs(db: Kysely<Database>, equipment: string): Promise<number[]> {
  const rows = await db
    .selectFrom('ingest.equipment_event')
    .select('seq')
    .where('equipment', '=', equipment)
    .orderBy('seq')
    .execute();
  return rows.map((r) => r.seq);
}

async function incidents(db: Kysely<Database>) {
  return db
    .selectFrom('ingest.data_quality_incident')
    .select(['origin', 'type', 'stream', 'epoch', 'seq_from', 'seq_to', 'lost', 'resolution'])
    .orderBy('id')
    .execute();
}

describe('ingest (#95)', () => {
  it('stores every fact once with its typed columns; duplicates are dropped', async () => {
    const { db, equipment, start } = await setup();
    const registry = new Registry();
    const ingest = await start({ registry });
    const notices: IngestNotice[] = [];
    ingest.onStored((notice) => {
      notices.push(notice);
    });
    const at = equipment('cnc');
    const id = at.equipment;
    const down = stateEvent(id, EPOCH, 2, 'Down');
    const cycle = {
      schema: 'uns.events.cycle-complete/1' as const,
      scope: 'device' as const,
      ...identity(id, EPOCH, 3),
      value: {
        product: 'VB-100',
        partId: 1,
        serial: 'S1',
        result: 'good' as const,
        reason: null,
        measurement: null,
      },
    };
    const alarm = {
      schema: 'uns.alarms/1' as const,
      scope: 'device' as const,
      ...identity(id, EPOCH, 4),
      value: { code: 'SPINDLE-FAULT', transition: 'active' as const, severity: 800 },
    };
    const sample = {
      schema: 'uns.telemetry/1' as const,
      scope: 'topic' as const,
      unit: '%',
      ...identity(id, GW_EPOCH, 1),
      value: 41.5,
    };
    await publish(stateTopic(at), stateEvent(id, EPOCH, 1));
    await publish(stateTopic(at), down);
    await publish(stateTopic(at), down); // a QoS 1 duplicate
    await publish(cycleTopic(at), cycle);
    await publish(alarmTopic(at, 'SPINDLE-FAULT'), alarm);
    await publish(telemetryTopic(at, 'spindle-load'), sample);
    await publish(telemetryTopic(at, 'spindle-load'), sample);
    await waitFor(() => handled(ingest) === 7, 'seven deliveries');

    expect(ingest.count('stored')).toBe(5);
    expect(ingest.count('duplicate')).toBe(2);
    const events = await db
      .selectFrom('ingest.equipment_event')
      .selectAll()
      .where('equipment', '=', id)
      .orderBy('seq')
      .execute();
    expect(
      events.map((e) => [e.seq, e.event_type, e.state, e.cause, e.quality, e.source_protocol]),
    ).toEqual([
      [1, 'state', 'Running', null, 'good', 'opcua'],
      [2, 'state', 'Down', 'SPINDLE-FAULT', 'good', 'opcua'],
      [3, 'cycle', null, null, 'good', 'opcua'],
      [4, 'alarm', null, null, 'good', 'opcua'],
    ]);
    expect(events[1]?.payload).toEqual(down);
    expect(events[1]?.source_time).toEqual(new Date(down.sourceTime));
    expect(events[1]?.received_at).toEqual(new Date(down.receivedAt));
    const samples = await db.selectFrom('ingest.telemetry_sample').selectAll().execute();
    expect(samples.map((s) => [s.equipment, s.name, s.value, s.unit, s.seq])).toEqual([
      [id, 'spindle-load', 41.5, '%', 1],
    ]);
    // The stream's first fact opens its epoch; a cycle also sends `cycle` (#118), an alarm
    // `alarm` (#141).
    expect(notices.map((n) => n.type)).toEqual([
      'epoch',
      'state',
      'state',
      'sample',
      'cycle',
      'sample',
      'alarm',
      'sample',
    ]);
    expect(notices[0]).toEqual({
      type: 'epoch',
      equipment: id,
      epoch: EPOCH,
      previous: null,
      sourceTime: new Date(sourceTime(1)),
    });
    expect(notices[4]).toEqual({
      type: 'cycle',
      cycle: {
        equipment: id,
        epoch: EPOCH,
        seq: 3,
        sourceTime: new Date(cycle.sourceTime),
        product: 'VB-100',
        result: 'good',
      },
    });
    // Device facts tell how far their stream is settled (#113); telemetry doesn't.
    expect(notices.map((n) => ('settledSeq' in n ? n.settledSeq : 'none'))).toEqual([
      'none',
      1,
      2,
      3,
      'none',
      4,
      4,
      'none',
    ]);
    expect(await ingest.stateFacts(id, EPOCH)).toMatchObject([
      { seq: 1, state: 'Running' },
      { seq: 2, state: 'Down', cause: 'SPINDLE-FAULT' },
    ]);
    expect(await ingest.epochs(id)).toEqual([EPOCH]);
    const metrics = await registry.metrics();
    expect(metrics).toMatch(/^mes_ingest_messages_total\{outcome="stored"\} 5$/m);
    expect(metrics).toMatch(/^mes_ingest_messages_total\{outcome="duplicate"\} 2$/m);
    expect(metrics).toMatch(/^mes_ingest_subscribed 1$/m);
  });

  it('accepts out-of-order facts, also below the first number seen, without reporting gaps', async () => {
    const { db, equipment, clock, start } = await setup();
    const ingest = await start();
    const at = equipment('lkt');
    for (const seq of [5, 3, 4, 1, 2, 6]) {
      await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, seq));
    }
    await waitFor(() => ingest.count('stored') === 6, 'six facts');
    expect(await ingest.sweep()).toBe(0);
    clock.now += GRACE_MS;
    expect(await ingest.sweep()).toBe(0);
    expect(await seqs(db, at.equipment)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      (await ingest.stateFacts(at.equipment, EPOCH, { fromSeq: 2, toSeq: 4 })).map((f) => f.seq),
    ).toEqual([2, 3, 4]);
    expect(await incidents(db)).toEqual([]);
  });

  it('records a gap as an incident after the grace period; late facts fill and close it, also after a restart', async () => {
    const { db, equipment, clock, start } = await setup();
    let ingest = await start();
    const notices: IngestNotice[] = [];
    ingest.onStored((notice) => {
      notices.push(notice);
    });
    const at = equipment('cnc');
    const stream = `device:${at.equipment}`;
    for (const seq of [1, 2, 6])
      await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, seq));
    await waitFor(() => ingest.count('stored') === 3, 'three facts');
    // The open gap holds the stream's settled part at 2 (#113).
    expect(await ingest.settled(at.equipment, EPOCH)).toMatchObject({
      settledSeq: 2,
      incidents: [],
    });
    expect(await ingest.sweep()).toBe(0);
    clock.now += GRACE_MS - 1;
    expect(await ingest.sweep()).toBe(0);
    clock.now += 1;
    expect(await ingest.sweep()).toBe(1);
    expect(await ingest.sweep()).toBe(0); // recorded once
    // Reported, the gap holds nothing back; listeners hear of it, and of where the gap lies.
    expect(notices.at(-1)).toEqual({
      type: 'gaps',
      equipment: at.equipment,
      epoch: EPOCH,
      settledSeq: 6,
    });
    expect(await ingest.settled(at.equipment, EPOCH)).toMatchObject({
      settledSeq: 6,
      settledTime: new Date(sourceTime(6)),
      incidents: [
        {
          seqFrom: 3,
          seqTo: 5,
          after: new Date(sourceTime(2)),
          before: new Date(sourceTime(6)),
        },
      ],
    });
    // Several streams in one read each (#232): the same incidents and progress.
    const settled = await ingest.settled(at.equipment, EPOCH);
    expect(
      await ingest.gapIncidents([
        { equipment: at.equipment, epoch: EPOCH },
        { equipment: at.equipment, epoch: EPOCH + 1 },
        { equipment: 'nowhere', epoch: EPOCH },
      ]),
    ).toEqual(settled.incidents.map((i) => ({ equipment: at.equipment, epoch: EPOCH, ...i })));
    expect(await ingest.gapIncidents([])).toEqual([]);
    const many = await ingest.deviceProgresses([at.equipment, 'nowhere', at.equipment]);
    expect([...many.keys()]).toEqual([at.equipment, 'nowhere']);
    expect(many.get(at.equipment)).toEqual(await ingest.deviceProgress(at.equipment));
    expect(many.get('nowhere')).toEqual(await ingest.deviceProgress('nowhere'));
    expect((await ingest.deviceProgresses([])).size).toBe(0);
    // Only the facts above `afterSeq` are read for the time.
    expect((await ingest.settled(at.equipment, EPOCH, 6)).settledTime).toBeNull();
    expect(await ingest.settled(at.equipment, EPOCH + 1)).toMatchObject({ settledSeq: null });
    expect(await incidents(db)).toEqual([
      {
        origin: 'mes',
        type: 'sequence-gap',
        stream,
        epoch: EPOCH,
        seq_from: 3,
        seq_to: 5,
        lost: 3,
        resolution: null,
      },
    ]);

    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, 4));
    await waitFor(() => ingest.count('stored') === 4, 'the first late fact');
    expect((await incidents(db))[0]?.lost).toBe(2);

    // The gap state is durable: a new process carries on from the cursor table.
    await ingest.stop();
    ingest = await start();
    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, 3));
    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, 5));
    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, 6)); // already stored
    await waitFor(() => handled(ingest) === 3, 'the late facts');
    expect(ingest.count('duplicate')).toBe(1);
    const [closed] = await db.selectFrom('ingest.data_quality_incident').selectAll().execute();
    expect(closed).toMatchObject({ lost: 0, resolution: 'filled' });
    expect(closed?.closed_at).toEqual(new Date(clock.now));
    expect(await seqs(db, at.equipment)).toEqual([1, 2, 3, 4, 5, 6]);
    clock.now += GRACE_MS;
    expect(await ingest.sweep()).toBe(0);
  });

  it('refuses an older epoch as stale; a newer epoch starts over and closes the old gaps', async () => {
    const { db, equipment, start } = await setup();
    const ingest = await start();
    const at = equipment('wsh');
    const stream = `device:${at.equipment}`;
    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, 1));
    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, 3));
    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH - 10, 9));
    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH + 10, 1));
    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, 2)); // the old epoch is over
    await waitFor(() => handled(ingest) === 5, 'five deliveries');

    expect(ingest.count('stored')).toBe(3);
    const rejected = await db
      .selectFrom('ingest.rejected_message')
      .selectAll()
      .orderBy('id')
      .execute();
    expect(
      rejected.map((r) => [r.reason, (JSON.parse(r.payload) as { epoch: number }).epoch, r.topic]),
    ).toEqual([
      ['stale-epoch', EPOCH - 10, stateTopic(at)],
      ['stale-epoch', EPOCH, stateTopic(at)],
    ]);
    expect(rejected[0]?.detail).toMatch(/older than the stream's current epoch/);
    expect(await incidents(db)).toEqual([
      {
        origin: 'mes',
        type: 'sequence-gap',
        stream,
        epoch: EPOCH,
        seq_from: 2,
        seq_to: 2,
        lost: 1,
        resolution: 'epoch-ended',
      },
    ]);
    const cursor = await db
      .selectFrom('ingest.source_cursor')
      .selectAll()
      .where('stream', '=', stream)
      .executeTakeFirstOrThrow();
    // The new epoch numbers from 1, so the sentinel 0 joins its first number: no gap.
    expect([cursor.epoch, cursor.seen, cursor.reported]).toEqual([EPOCH + 10, [[0, 1]], []]);
    expect(await ingest.epochs(at.equipment)).toEqual([EPOCH, EPOCH + 10]);
  });

  it('stores retained deliveries and snapshots as anchors, never as facts', async () => {
    const { db, equipment, clock, start } = await setup();
    const a = equipment('cnc');
    const b = equipment('wsh');
    // Retained before the MES subscribes: state of A (a fact it never saw), a snapshot of B, and
    // A's last telemetry and alarm.
    await publish(stateTopic(a), stateEvent(a.equipment, EPOCH, 7, 'Setup'), true);
    await publish(stateTopic(b), snapshot(b.equipment, 3, 'Idle'), true);
    await publish(
      telemetryTopic(a, 'spindle-load'),
      {
        schema: 'uns.telemetry/1',
        scope: 'topic',
        unit: '%',
        ...identity(a.equipment, GW_EPOCH, 9),
        value: 3,
      },
      true,
    );
    await publish(
      alarmTopic(a, 'X'),
      {
        schema: 'uns.alarms/1',
        scope: 'device',
        ...identity(a.equipment, EPOCH, 5),
        value: { code: 'X', transition: 'cleared', severity: 10 },
      },
      true,
    );
    cleanup.push(async () => {
      for (const topic of [
        stateTopic(a),
        stateTopic(b),
        telemetryTopic(a, 'spindle-load'),
        alarmTopic(a, 'X'),
      ]) {
        await publish(topic, '', true); // clears the retained message
      }
    });
    let ingest = await start();
    const notices: IngestNotice[] = [];
    ingest.onStored((notice) => {
      notices.push(notice);
    });
    await waitFor(() => handled(ingest) === 4, 'the retained messages');
    // The retained alarm is an anchor too (#141); only the telemetry is a current value.
    expect(ingest.count('anchor')).toBe(3);
    expect(ingest.count('retained')).toBe(1);
    expect(await db.selectFrom('ingest.equipment_event').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('ingest.telemetry_sample').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('ingest.source_cursor').selectAll().execute()).toEqual([]);
    expect(await ingest.anchor(a.equipment, EPOCH)).toMatchObject({
      state: 'Setup',
      kind: 'event',
      retained: true,
      deviceEpoch: EPOCH,
    });

    // Live facts: A's stream starts at 9, so the retained 7 makes no gap; B's first fact tells the
    // snapshot's device epoch.
    await publish(stateTopic(a), stateEvent(a.equipment, EPOCH, 9));
    await publish(stateTopic(b), stateEvent(b.equipment, EPOCH + 5, 1, 'Running'));
    await waitFor(() => ingest.count('stored') === 2, 'two live facts');
    expect(await ingest.anchor(b.equipment, EPOCH + 5)).toMatchObject({
      state: 'Idle',
      kind: 'snapshot',
      retained: true,
      deviceEpoch: EPOCH + 5,
    });
    expect(notices.filter((n) => n.type === 'alarm-anchor')).toHaveLength(1);
    expect(notices.map((n) => n.type).filter((type) => type !== 'alarm-anchor')).toEqual([
      'anchor',
      'epoch',
      'state',
      'epoch',
      'anchor',
      'state',
    ]);
    clock.now += GRACE_MS;
    expect(await ingest.sweep()).toBe(0);

    // A live snapshot after a reconnect anchors too, but the first anchor of an epoch wins.
    await publish(stateTopic(b), snapshot(b.equipment, 4, 'Down'));
    await publish(stateTopic(b), stateEvent(b.equipment, EPOCH + 5, 2, 'Down'));
    await waitFor(() => ingest.count('stored') === 3, 'the next fact');
    expect(await ingest.anchor(b.equipment, EPOCH + 5)).toMatchObject({ state: 'Idle' });

    // A restart gets the retained messages again: no new anchors, no facts.
    await ingest.stop();
    ingest = await start();
    await waitFor(() => handled(ingest) === 4, 'the retained messages again');
    expect(ingest.count('anchor')).toBe(3);
    const anchors = await db
      .selectFrom('ingest.state_anchor')
      .select(['equipment', 'kind', 'device_epoch'])
      .orderBy('arrival')
      .execute();
    expect(anchors).toEqual([
      { equipment: a.equipment, kind: 'event', device_epoch: EPOCH },
      { equipment: b.equipment, kind: 'snapshot', device_epoch: EPOCH + 5 },
      { equipment: b.equipment, kind: 'snapshot', device_epoch: EPOCH + 5 },
    ]);
    expect(await seqs(db, a.equipment)).toEqual([9]);
  });

  it('stores invalid messages in rejected_message with the reason, never dropping them', async () => {
    const { db, equipment, start } = await setup();
    const ingest = await start();
    const at = equipment('cnc');
    const valid = stateEvent(at.equipment, EPOCH, 1);
    const cases: [string, string, string][] = [
      [stateTopic(at), '{oops', 'invalid-json'],
      [stateTopic(at), JSON.stringify({ ...valid, quality: 'great' }), 'invalid-payload'],
      [
        stateTopic(at),
        JSON.stringify({ ...valid, schema: 'uns.state.current/9' }),
        'invalid-payload',
      ],
      [
        stateTopic(at),
        JSON.stringify({ ...valid, value: { state: 'Running', cause: 'a\u0000b' } }),
        'invalid-payload',
      ],
      [telemetryTopic(at, 'spindle-load'), JSON.stringify(valid), 'topic-mismatch'],
      [
        stateTopic(at),
        JSON.stringify({ ...valid, source: { id: 'someone-else', protocol: 'opcua' } }),
        'topic-mismatch',
      ],
      [
        `orbis/gebze/machining/cell-t/${at.equipment}/events/unknown`,
        JSON.stringify(valid),
        'unexpected-topic',
      ],
    ];
    for (const [topic, payload] of cases) await publish(topic, payload);
    await waitFor(() => ingest.count('rejected') === cases.length, 'every rejection');
    const rows = await db.selectFrom('ingest.rejected_message').selectAll().orderBy('id').execute();
    expect(rows.map((r) => [r.topic, r.reason])).toEqual(
      cases.map(([topic, , reason]) => [topic, reason]),
    );
    expect(rows[0]?.payload).toBe('{oops');
    expect(rows.every((r) => r.detail.length > 0 && !r.retained)).toBe(true);
    expect(await db.selectFrom('ingest.equipment_event').selectAll().execute()).toEqual([]);
  });

  it("stores the gateway's incidents once and its latest status", async () => {
    const { db, start } = await setup();
    const ingest = await start();
    const gateway = (seq: number) => identity('gw-01', GW_EPOCH, seq);
    const incident = {
      schema: 'uns.sys.incident/1' as const,
      scope: 'topic' as const,
      ...gateway(1),
      source: { id: 'gw-01', protocol: 'internal' as const },
      value: { type: 'sequence-gap' as const, equipment: 'cnc-01', lost: 2, message: 'two lost' },
    };
    const status = (seq: number, value: 'online' | 'offline') => ({
      schema: 'uns.sys.status/1' as const,
      scope: 'topic' as const,
      ...gateway(seq),
      source: { id: 'gw-01', protocol: 'internal' as const },
      value: { status: value, startedAt: '2026-10-15T09:00:00.000Z', version: '0.0.0' },
    });
    const incidents = sysTopic('edge-gateway', 'gw-01', 'incidents');
    await publish(incidents, incident);
    await publish(incidents, incident);
    await publish(sysTopic('edge-gateway', 'gw-01', 'status'), status(2, 'online'));
    await publish(sysTopic('edge-gateway', 'gw-01', 'status'), status(1, 'offline'));
    await waitFor(() => handled(ingest) === 4, 'four deliveries');
    expect(
      await db
        .selectFrom('ingest.data_quality_incident')
        .select(['origin', 'type', 'equipment', 'lost', 'message'])
        .execute(),
    ).toEqual([
      {
        origin: 'gateway',
        type: 'sequence-gap',
        equipment: 'cnc-01',
        lost: 2,
        message: 'two lost',
      },
    ]);
    // The latest delivery wins, not the highest number (docs/contracts/uns.md).
    expect(
      await db
        .selectFrom('ingest.component_status')
        .select(['component', 'instance', 'status'])
        .execute(),
    ).toEqual([{ component: 'edge-gateway', instance: 'gw-01', status: 'offline' }]);
  });

  it('retries a message whose transaction failed, in order, instead of acknowledging it', async () => {
    const { db, equipment, start } = await setup();
    const registry = new Registry();
    let failures = 2;
    const ingest = await start({
      registry,
      beforeCommit: () =>
        failures-- > 0 ? Promise.reject(new Error('database hiccup')) : Promise.resolve(),
    });
    const at = equipment('cnc');
    for (const seq of [1, 2]) await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, seq));
    await waitFor(() => ingest.count('stored') === 2, 'both facts');
    expect(await seqs(db, at.equipment)).toEqual([1, 2]);
    expect(await registry.metrics()).toMatch(/^mes_ingest_store_errors_total 2$/m);
  });

  it('acknowledges only after commit: an MES crash mid-stream loses and doubles nothing', async () => {
    const { db, equipment, clock, start } = await setup();
    const at = equipment('cnc');
    let calls = 0;
    let fail: (error: Error) => void = () => undefined;
    const hung = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const first = await start({
      // The sixth transaction never commits: the process "crashes" inside it.
      beforeCommit: async () => {
        if (++calls === 6) await hung;
      },
    });
    for (let seq = 1; seq <= 10; seq++)
      await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, seq));
    await waitFor(() => calls === 6, 'the sixth transaction');
    await first.stop(); // the session ends with 6–10 delivered but unacknowledged
    fail(new Error('crashed'));
    expect(await seqs(db, at.equipment)).toEqual([1, 2, 3, 4, 5]);

    // While the MES is down the broker queues for its persistent session.
    for (let seq = 11; seq <= 20; seq++)
      await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, seq));
    const second = await start();
    await waitFor(async () => (await seqs(db, at.equipment)).length === 20, 'all twenty facts');
    expect(await seqs(db, at.equipment)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(second.count('stored')).toBe(15);
    clock.now += GRACE_MS;
    expect(await second.sweep()).toBe(0);
    expect(await incidents(db)).toEqual([]);
    const cursor = await db
      .selectFrom('ingest.source_cursor')
      .select('seen')
      .where('stream', '=', `device:${at.equipment}`)
      .executeTakeFirstOrThrow();
    expect(cursor.seen).toEqual([[1, 20]]);
    await second.stop();
    expect(second.subscribed).toBe(false);
  });

  it('anchors a snapshot to its deviceEpoch; a stale retained snapshot of an earlier run never wins', async () => {
    const { equipment, start } = await setup();
    const a = equipment('cnc');
    const b = equipment('lkt');
    // On a persistent broker, the retained snapshot is from an earlier simulator run (EPOCH - 50).
    await publish(stateTopic(a), snapshot(a.equipment, 1, 'Down', EPOCH - 50), true);
    cleanup.push(() => publish(stateTopic(a), '', true));
    const ingest = await start();
    const notices: IngestNotice[] = [];
    ingest.onStored((notice) => {
      notices.push(notice);
    });
    await waitFor(() => ingest.count('anchor') === 1, 'the retained snapshot');
    // The new run: the gateway's snapshot names it; no device fact is needed (B stays silent).
    await publish(stateTopic(a), snapshot(a.equipment, 2, 'Idle', EPOCH));
    await publish(stateTopic(b), snapshot(b.equipment, 3, 'Off', EPOCH));
    await publish(stateTopic(a), stateEvent(a.equipment, EPOCH, 1, 'Running'));
    await waitFor(() => ingest.count('stored') === 1, 'the first fact');
    expect(await ingest.anchor(a.equipment, EPOCH)).toMatchObject({
      state: 'Idle',
      retained: false,
    });
    expect(await ingest.anchor(a.equipment, EPOCH - 50)).toMatchObject({ state: 'Down' });
    expect(await ingest.anchor(b.equipment, EPOCH)).toMatchObject({
      state: 'Off',
      deviceEpoch: EPOCH,
    });
    expect(notices.map((n) => n.type)).toEqual(['anchor', 'anchor', 'anchor', 'epoch', 'state']);
  });

  it('without deviceEpoch, the latest waiting snapshot takes the next fact’s epoch and older ones are superseded', async () => {
    const { db, equipment, start } = await setup();
    const a = equipment('cnc');
    const ingest = await start();
    await publish(stateTopic(a), snapshot(a.equipment, 1, 'Down'));
    await publish(stateTopic(a), snapshot(a.equipment, 2, 'Idle'));
    await publish(stateTopic(a), stateEvent(a.equipment, EPOCH, 5, 'Running'));
    await waitFor(() => ingest.count('stored') === 1, 'the fact');
    expect(await ingest.anchor(a.equipment, EPOCH)).toMatchObject({ state: 'Idle' });
    // A snapshot with deviceEpoch supersedes one still waiting without it.
    await publish(stateTopic(a), snapshot(a.equipment, 3, 'Setup'));
    await publish(stateTopic(a), snapshot(a.equipment, 4, 'Blocked', EPOCH + 1));
    await publish(stateTopic(a), stateEvent(a.equipment, EPOCH + 1, 1, 'Running'));
    await waitFor(() => ingest.count('stored') === 2, 'the next fact');
    expect(await ingest.anchor(a.equipment, EPOCH + 1)).toMatchObject({ state: 'Blocked' });
    const rows = await db
      .selectFrom('ingest.state_anchor')
      .select(['state', 'device_epoch', 'superseded'])
      .orderBy('arrival')
      .execute();
    expect(rows).toEqual([
      { state: 'Down', device_epoch: null, superseded: true },
      { state: 'Idle', device_epoch: EPOCH, superseded: false },
      { state: 'Setup', device_epoch: null, superseded: true },
      { state: 'Blocked', device_epoch: EPOCH + 1, superseded: false },
    ]);
  });

  it('counts numbers lost at the start of a new epoch as a gap, for device and topic streams', async () => {
    const { db, equipment, clock, start } = await setup();
    const ingest = await start();
    const at = equipment('wsh');
    const topic = telemetryTopic(at, 'bath-temperature');
    const sample = (epoch: number, seq: number) => ({
      schema: 'uns.telemetry/1' as const,
      scope: 'topic' as const,
      unit: '°C',
      ...identity(at.equipment, epoch, seq),
      value: 60,
    });
    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, 1));
    await publish(topic, sample(GW_EPOCH, 1));
    // Restarts: the device's new run arrives from 4, the gateway's telemetry from 3.
    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH + 1, 4));
    await publish(topic, sample(GW_EPOCH + 1, 3));
    await waitFor(() => ingest.count('stored') === 4, 'four facts');
    expect(await ingest.sweep()).toBe(0);
    clock.now += GRACE_MS;
    expect(await ingest.sweep()).toBe(2);
    expect((await incidents(db)).map((i) => [i.stream, i.epoch, i.seq_from, i.seq_to])).toEqual([
      [`device:${at.equipment}`, EPOCH + 1, 1, 3],
      [`topic:${topic}`, GW_EPOCH + 1, 1, 2],
    ]);
  });

  it('records what the database can never store and goes on; absurd times and lone surrogates are invalid', async () => {
    const { db, equipment, start } = await setup();
    const at = equipment('cnc');
    let poison = true;
    const ingest = await start({
      beforeCommit: () => {
        if (!poison) return Promise.resolve();
        poison = false;
        return Promise.reject(Object.assign(new Error('value out of range'), { code: '22003' }));
      },
    });
    const incident = {
      schema: 'uns.sys.incident/1' as const,
      scope: 'topic' as const,
      ...identity('gw-01', GW_EPOCH, 1),
      source: { id: 'gw-01', protocol: 'internal' as const },
      value: { type: 'buffer-overflow' as const, equipment: null, lost: 3e9, message: 'many' },
    };
    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, 1)); // hits the data error
    await publish(stateTopic(at), {
      ...stateEvent(at.equipment, EPOCH, 2),
      sourceTime: '0000-01-01T00:00:00Z',
    });
    await publish(
      stateTopic(at),
      JSON.stringify(stateEvent(at.equipment, EPOCH, 3)).replace(
        '"cause":null',
        '"cause":"\\ud800"',
      ),
    );
    await publish(sysTopic('edge-gateway', 'gw-01', 'incidents'), incident);
    await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, 4));
    await waitFor(() => handled(ingest) === 5, 'five deliveries');
    const rejected = await db
      .selectFrom('ingest.rejected_message')
      .select(['reason', 'detail'])
      .orderBy('id')
      .execute();
    expect(rejected.map((r) => r.reason)).toEqual([
      'unstorable',
      'invalid-payload',
      'invalid-payload',
    ]);
    expect(rejected[0]?.detail).toMatch(/SQLSTATE 22003/);
    expect(rejected[1]?.detail).toMatch(/sourceTime/);
    expect(rejected[2]?.detail).toMatch(/surrogate/);
    expect(await seqs(db, at.equipment)).toEqual([4]);
    expect((await incidents(db)).map((i) => i.lost)).toEqual([3e9]);
  });

  it('drops the session while the database stays unreachable, and resumes without loss', async () => {
    const { db, equipment, start } = await setup();
    const registry = new Registry();
    let outage = 3;
    const ingest = await start({
      registry,
      retry: { attempts: 2, baseMs: 10, resumeMs: 50 },
      beforeCommit: () =>
        outage-- > 0
          ? Promise.reject(Object.assign(new Error('connection lost'), { code: '08006' }))
          : Promise.resolve(),
    });
    const at = equipment('cnc');
    for (const seq of [1, 2, 3])
      await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, seq));
    await waitFor(async () => (await seqs(db, at.equipment)).length === 3, 'all three facts');
    await ingest.waitSubscribed();
    expect(await seqs(db, at.equipment)).toEqual([1, 2, 3]);
    expect(await registry.metrics()).toMatch(/^mes_ingest_suspensions_total [12]$/m);
  });

  it('a message committed but not acknowledged before a crash comes again as a duplicate with no effect', async () => {
    const { db, equipment, start } = await setup();
    const at = equipment('cnc');
    let calls = 0;
    const first = await start({
      // The third message is committed, then the process "crashes" before its PUBACK.
      beforeAck: async () => {
        if (++calls === 3) await new Promise(() => undefined);
      },
    });
    for (let seq = 1; seq <= 5; seq++)
      await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, seq));
    await waitFor(() => calls === 3, 'the third commit');
    await first.stop();
    expect(await seqs(db, at.equipment)).toEqual([1, 2, 3]);
    const second = await start();
    await waitFor(async () => (await seqs(db, at.equipment)).length === 5, 'all five facts');
    await waitFor(() => second.count('duplicate') === 1, 'the redelivered third fact');
    expect(await seqs(db, at.equipment)).toEqual([1, 2, 3, 4, 5]);
    // The copy of 3 changed nothing: only 4 and 5 were stored by the second session.
    expect(second.count('stored')).toBe(2);
  });

  it('waits out a held lock (lock_timeout, 55P03): facts are never acknowledged unstored, and arrive once it is released', async () => {
    const { db, url, equipment, start } = await setup();
    // The MES's own connections give up on a lock after 200 ms.
    const timed = createDatabase(`${url}?options=${encodeURIComponent('-c lock_timeout=200')}`, 3);
    cleanup.push(() => timed.destroy());
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    cleanup.push(() => holder.end());
    const registry = new Registry();
    const ingest = await start({
      db: timed,
      registry,
      retry: { attempts: 2, baseMs: 10, resumeMs: 100 },
    });
    const at = equipment('cnc');
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE ingest.equipment_event IN ACCESS EXCLUSIVE MODE');
    for (const seq of [1, 2, 3])
      await publish(stateTopic(at), stateEvent(at.equipment, EPOCH, seq));
    await waitFor(
      async () => /^mes_ingest_suspensions_total [1-9]/m.test(await registry.metrics()),
      'a suspension',
    );
    expect(ingest.count('stored')).toBe(0);
    await holder.query('COMMIT');
    await waitFor(async () => (await seqs(db, at.equipment)).length === 3, 'all three facts');
    expect(await seqs(db, at.equipment)).toEqual([1, 2, 3]);
    expect(await db.selectFrom('ingest.rejected_message').selectAll().execute()).toEqual([]);
  });
});
