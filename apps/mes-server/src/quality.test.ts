/**
 * The `quality` module, SPC part (#200), against a real database (as `mes_app`) and the real
 * ingest store: measurements and passes from the leak tester's cycle facts, limit version 1 only
 * once the baseline is final (created at its last reading, audited by `system`), episodes
 * provisional until the tester is final through the triggering point, a late reading that moves a
 * provisional episode (deleted, or withdrawn when acknowledged), a late reading from a written-off
 * gap that withdraws a final episode and raises `baseline-changed` instead of re-deriving version
 * 1, limit writes and acknowledgements (version, 409 types, audit), the API, a restart, and the
 * pure parts (`passesOf`, `planSignals`, `versionsOf`).
 */
import type { EquipmentPath } from '@shopfloor/contracts';
import {
  PROBLEM_TYPES,
  characteristicListSchema,
  characteristicSchema,
  limitsWriteResultSchema,
  measurementListSchema,
  spcChartSchema,
  spcSignalListSchema,
  spcSignalSchema,
} from '@shopfloor/contracts/mes-api';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { DEFAULT_RULES } from '@shopfloor/spc-core';
import type { Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { buildMesHttp } from './http.ts';
import { PLANT_CONFIG, UnsFeed, freshDatabase } from './modules/equipment/test-support.ts';
import { Identity } from './modules/identity/index.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData } from './modules/master-data/index.ts';
import {
  Quality,
  QualityError,
  WITHDRAWN_FINAL,
  WITHDRAWN_PROVISIONAL,
  characteristicsOf,
  passesOf,
  planSignals,
  versionsOf,
  type CharacteristicConfig,
  type DerivedSignal,
  type QualityChange,
  type SignalRecord,
} from './modules/quality/index.ts';
import type { ApiSources } from './modules/realtime/index.ts';
import { startDatabase } from './testing.ts';

const T0 = Date.parse('2026-10-12T03:00:00.000Z');
const E1 = 1_760_000_000;
const MINUTE = 60_000;

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
let paths: Map<string, EquipmentPath>;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
  paths = new Map();
  for (const area of plant.plant.areas) {
    for (const wc of area.workCenters) {
      for (const item of wc.equipment) {
        paths.set(item.id, { area: area.id, workCenter: wc.id, equipment: item.id });
      }
    }
  }
}, 180_000);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

afterAll(async () => {
  await container.stop();
});

/**
 * A small characteristic: subgroups of 2, a baseline of 3 subgroups (6 readings). With the
 * baseline below (2.000, 2.100, 1.900, 2.050, 1.950, 2.000 Pa/min) the limits are, in steps:
 * I 2000 ± 2.66·120 = [1680.8, 2319.2]; X̄ 2000 ± 1.880·100 = [1812, 2188]; R up to 326.7.
 */
const SMALL: CharacteristicConfig = {
  id: 'leak-rate',
  name: 'Leak rate',
  equipment: 'lkt-01',
  operation: 'OP40',
  unit: 'Pa/min',
  resolution: 0.001,
  upperSpec: 3.2,
  subgroupSize: 2,
  baselineSubgroups: 3,
  rules: DEFAULT_RULES,
};
const BASELINE = [2.0, 2.1, 1.9, 2.05, 1.95, 2.0];

interface Harness {
  readonly db: Kysely<Database>;
  readonly ingest: Ingest;
  quality: Quality;
  readonly changes: QualityChange[];
  readonly clock: { now: number };
  /** The leak tester's cycle with this seq (part = seq unless given), a reading in Pa/min. */
  cycle(
    seq: number,
    value: number,
    options?: { partId?: number; result?: 'good' | 'scrap' | 'rework' },
  ): Promise<void>;
  tick(): Promise<void>;
  signals(): Promise<SignalRecord[]>;
  restart(): Promise<Quality>;
  readonly by: { by: { userId: number; username: string; roles: ['quality'] }; requestId: string };
}

async function harness(name: string, options: { gapGraceMs?: number } = {}): Promise<Harness> {
  const db = await freshDatabase(serverUrl, `quality_${name}`);
  cleanups.push(() => db.destroy());
  await new MasterData(db).seed(plant);
  const identity = new Identity({ db, sweepMs: 0, hashParams: { N: 1024, r: 8, p: 1 } });
  const quinn = await identity.createUser(
    {
      username: 'quinn',
      roles: ['quality'],
      password: 'a-long-test-password',
      mustChangePassword: false,
    },
    { system: 'test' },
  );
  const clock = { now: T0 };
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'x',
    sweepIntervalMs: 0,
    gapGraceMs: options.gapGraceMs ?? 3_600_000,
    now: () => clock.now,
  });
  const feed = new UnsFeed(paths);
  const changes: QualityChange[] = [];
  const make = async (): Promise<Quality> => {
    const quality = new Quality({
      db,
      ingest,
      characteristics: [SMALL],
      clock: () => new Date(clock.now),
      tickMs: 0,
    });
    quality.onChange((change) => changes.push(change));
    await quality.start();
    cleanups.push(() => quality.stop());
    return quality;
  };
  const h: Harness = {
    db,
    ingest,
    quality: await make(),
    changes,
    clock,
    cycle: async (seq, value, o = {}) => {
      const d = feed.cycle('lkt-01', E1, seq, T0 + seq * MINUTE, {
        product: 'VB-100',
        partId: o.partId ?? seq,
        serial: `VB-100-${String(o.partId ?? seq).padStart(6, '0')}`,
        result: o.result ?? (value > 3.2 ? 'rework' : 'good'),
        measurement: { characteristic: 'leak-rate', value, unit: 'Pa/min', upperLimit: 3.2 },
        lots: [],
        operator: null,
      });
      await ingest.deliver(d.topic, d.payload);
    },
    tick: () => h.quality.tick(),
    signals: async () =>
      (await h.quality.signals({ characteristic: 'leak-rate', withdrawn: true })).signals.sort(
        (a, b) => a.first.seq - b.first.seq || a.chart.localeCompare(b.chart) || a.rule - b.rule,
      ),
    restart: async () => {
      await h.quality.stop();
      h.quality = await make();
      return h.quality;
    },
    by: {
      by: { userId: quinn.id, username: 'quinn', roles: ['quality'] },
      requestId: 'req-q',
    },
  };
  return h;
}

const shape = (s: SignalRecord) => [
  s.chart,
  s.rule,
  s.first.seq,
  s.status,
  s.closedBy?.seq ?? null,
];

describe('quality: measurements, limit version 1 and episodes on final data (#200)', () => {
  it('counts passes per part and charts first passes only; retests are listed apart', async () => {
    const h = await harness('passes');
    // Part 1 fails (rework), comes back as seq 3 (pass 2); part 2 is good.
    await h.cycle(1, 3.4, { partId: 1, result: 'rework' });
    await h.cycle(2, 2.0, { partId: 2 });
    await h.cycle(3, 2.2, { partId: 1, result: 'good' });
    await h.tick();
    const listed = await h.quality.measurements('leak-rate');
    expect(listed?.measurements.map((m) => [m.partId, m.pass, m.steps, m.result, m.final])).toEqual(
      [
        [1, 1, 3400, 'rework', true],
        [2, 1, 2000, 'good', true],
        [1, 2, 2200, 'good', true],
      ],
    );
    const view = await h.quality.chart('leak-rate');
    expect(view?.chart.firstPass.map((r) => r.key)).toEqual([
      `${String(E1)}/1/1`,
      `${String(E1)}/2/1`,
    ]);
    expect(view?.retests.map((r) => [r.partId, r.pass])).toEqual([[1, 2]]);
    expect(await h.quality.measurements('nope')).toBeUndefined();
    expect(await h.quality.chart('nope')).toBeUndefined();
  });

  it('estimates version 1 once the baseline is final, at its last reading, and judges it retroactively', async () => {
    const h = await harness('v1');
    for (const [i, value] of BASELINE.entries()) if (i !== 2) await h.cycle(i + 1, value);
    await h.tick();
    // Seq 3 is missing: the tester is final through 2 only, so no version yet.
    expect(await h.quality.limits('leak-rate')).toEqual([]);
    expect((await h.quality.characteristic('leak-rate'))?.baseline).toEqual({
      needed: 6,
      final: 2,
    });
    await h.cycle(3, BASELINE[2] ?? 0);
    await h.tick();
    const [v1] = (await h.quality.limits('leak-rate')) ?? [];
    expect(v1).toMatchObject({
      version: 1,
      createdAt: T0 + 6 * MINUTE,
      createdBy: 'system',
      from: null,
      until: null,
    });
    expect(v1?.limits.counts).toEqual({ readings: 6, movingRanges: 5, subgroups: 3 });
    const audit = await Identity.auditEntries(h.db, 'control_limit', ['leak-rate/1']);
    expect(audit).toMatchObject([{ action: 'spc.limits-create', username: 'quality' }]);
    expect(h.changes.filter((c) => c.type === 'characteristic').map((c) => c.event)).toContain(
      'limits',
    );
    // A reading far above: an I rule 1 episode at once (final: nothing missing below it); the
    // next reading closes it and completes a subgroup beyond the X̄ and R limits.
    await h.cycle(7, 2.5);
    await h.tick();
    expect((await h.signals()).map(shape)).toEqual([['I', 1, 7, 'final', null]]);
    await h.cycle(8, 2.0);
    await h.tick();
    expect((await h.signals()).map(shape)).toEqual([
      ['I', 1, 7, 'final', 8],
      ['R', 1, 8, 'final', null],
      ['Xbar', 1, 8, 'final', null],
    ]);
    expect(h.changes.filter((c) => c.type === 'signal').map((c) => c.event)).toEqual([
      'opened',
      'updated',
      'opened',
      'opened',
    ]);
    // Version 1 is never re-derived by later readings.
    expect((await h.quality.limits('leak-rate'))?.length).toBe(1);
  });

  it('keeps a signal provisional until the tester is final through it; a late reading moves it', async () => {
    const h = await harness('provisional');
    for (const [i, value] of BASELINE.entries()) await h.cycle(i + 1, value);
    await h.cycle(7, 2.0);
    await h.cycle(8, 2.0);
    // Seq 9 is missing: the subgroups after 8 are (10, 11), beyond the X̄ limit, provisional.
    await h.cycle(10, 2.45);
    await h.cycle(11, 2.2);
    await h.tick();
    expect((await h.signals()).map(shape)).toEqual([
      ['I', 1, 10, 'provisional', 11],
      ['Xbar', 1, 11, 'provisional', null],
    ]);
    const [, xbar] = await h.signals();
    if (!xbar) throw new Error('no X̄ signal');
    const acked = await h.quality.acknowledge(
      xbar.id,
      { version: xbar.rowVersion, comment: 'looking at it' },
      h.by,
    );
    expect(acked.acknowledged).toMatchObject({ by: 'quinn', comment: 'looking at it' });
    // Seq 9 arrives: the subgroups are (9, 10) and 11 pending. The acknowledged provisional X̄
    // episode is withdrawn (its acknowledgement orphaned); the I episode becomes final.
    await h.cycle(9, 2.0);
    await h.tick();
    const after = await h.signals();
    expect(after.map(shape)).toEqual([
      ['I', 1, 10, 'final', 11],
      ['R', 1, 10, 'final', null],
      ['Xbar', 1, 10, 'final', null],
      ['Xbar', 1, 11, 'withdrawn', null],
    ]);
    expect(after[3]).toMatchObject({
      withdrawnReason: WITHDRAWN_PROVISIONAL,
      acknowledged: { by: 'quinn' },
    });
    // Unacknowledged provisional episodes that go away are simply deleted: without seq 12 the
    // subgroup (11, 13) and the run 10, 11, 13 signal rule 5 (and the X̄ episode at 10 goes on);
    // with it, nothing new does.
    await h.cycle(13, 2.25);
    await h.tick();
    expect((await h.signals()).filter((s) => s.first.seq >= 12).map(shape)).toEqual([
      ['I', 5, 13, 'provisional', null],
      ['Xbar', 5, 13, 'provisional', null],
    ]);
    expect((await h.signals()).find((s) => s.chart === 'Xbar' && s.first.seq === 10)).toMatchObject(
      { points: 2, last: { seq: 13 }, closedBy: null },
    );
    await h.cycle(12, 2.0);
    await h.cycle(14, 2.0);
    await h.tick();
    expect((await h.signals()).filter((s) => s.first.seq >= 12)).toEqual([]);
    expect(
      h.changes
        .filter((c) => c.type === 'signal' && c.event === 'removed')
        .map((c) => (c.type === 'signal' ? `${c.signal.chart} ${String(c.signal.rule)}` : ''))
        .sort(),
    ).toEqual(['I 5', 'Xbar 5']);
    expect((await h.signals()).find((s) => s.chart === 'Xbar' && s.first.seq === 10)).toMatchObject(
      { points: 1, last: { seq: 10 }, closedBy: { seq: 12 } },
    );
  });

  it('withdraws a final episode on a late reading from a written-off gap and never re-derives version 1', async () => {
    const h = await harness('writeoff', { gapGraceMs: 0 });
    // Seq 3 of the baseline is lost: written off, version 1 rests on the readings that came.
    for (const [i, value] of BASELINE.entries()) if (i !== 2) await h.cycle(i + 1, value);
    await h.cycle(7, 2.0);
    await h.cycle(8, 2.45);
    await h.cycle(10, 2.0);
    h.clock.now += MINUTE;
    await h.ingest.sweep();
    await h.tick();
    // Version 1 from the first three complete subgroups that came: (1, 2), (4, 5), (6, 7).
    const [v1] = (await h.quality.limits('leak-rate')) ?? [];
    expect(v1?.limits.counts).toEqual({ readings: 6, movingRanges: 5, subgroups: 3 });
    expect(v1?.createdAt).toBe(T0 + 7 * MINUTE);
    // The written-off seq 9 leaves (8, 10) as a subgroup beyond the X̄ limit: final.
    expect((await h.signals()).map(shape)).toContainEqual(['Xbar', 1, 10, 'final', null]);
    const xbar = (await h.signals()).find((s) => s.chart === 'Xbar' && s.first.seq === 10);
    if (!xbar) throw new Error('no X̄ signal');
    await h.quality.acknowledge(xbar.id, { version: xbar.rowVersion, comment: 'seen' }, h.by);
    // The lost facts arrive after all: seq 9 moves the subgroups, seq 3 lies in the baseline.
    await h.cycle(9, 2.0);
    await h.cycle(3, 1.9);
    await h.tick();
    const after = await h.signals();
    expect(after.find((s) => s.id === xbar.id)).toMatchObject({
      status: 'withdrawn',
      withdrawnReason: WITHDRAWN_FINAL,
      acknowledged: { by: 'quinn', comment: 'seen' },
    });
    expect(h.changes).toContainEqual(
      expect.objectContaining({ type: 'signal', event: 'withdrawn' }),
    );
    // Version 1 is not re-derived: a notice says the baseline changed.
    const limits = (await h.quality.limits('leak-rate')) ?? [];
    expect(limits.map((v) => v.version)).toEqual([1]);
    expect(limits[0]?.limits).toEqual(v1?.limits);
    const characteristic = await h.quality.characteristic('leak-rate');
    expect(characteristic?.notice).toMatchObject({ kind: 'baseline-changed' });
    expect(characteristic?.notice?.detail).toContain('version 1 stays');
    expect((await h.signals()).map(shape)).toContainEqual(['Xbar', 1, 8, 'final', 10]);
    // A quality user decides: version 2 from the whole window clears the notice.
    h.clock.now = T0 + 20 * MINUTE;
    const created = await h.quality.createLimits(
      'leak-rate',
      {
        version: characteristic?.version ?? 0,
        from: new Date(T0),
        to: new Date(T0 + 11 * MINUTE),
        comment: 'baseline with the late reading',
      },
      h.by,
    );
    expect(created.limits).toMatchObject({ version: 2, createdBy: 'quinn' });
    expect(created.characteristic.notice).toBeNull();
  });
});

describe('quality: limit writes and acknowledgements (#200)', () => {
  it('creates and ends versions with the version read, audited; refuses stale, early and empty writes', async () => {
    const h = await harness('limits');
    // Before version 1: refused (it is automatic).
    await h.cycle(1, 2.0);
    await h.cycle(2, 2.1);
    await h.tick();
    const early = await h.quality
      .createLimits(
        'leak-rate',
        { version: 1, from: new Date(T0), to: new Date(T0 + 2 * MINUTE), comment: 'too early' },
        h.by,
      )
      .catch((error: unknown) => error);
    expect(early).toMatchObject({ kind: 'conflict' });
    for (const [i, value] of BASELINE.entries()) if (i > 1) await h.cycle(i + 1, value);
    for (let seq = 7; seq <= 12; seq++) await h.cycle(seq, 2.0 + (seq % 2) * 0.05);
    await h.tick();
    const characteristic = await h.quality.characteristic('leak-rate');
    expect(characteristic?.version).toBe(2);
    const stale = await h.quality
      .createLimits(
        'leak-rate',
        { version: 1, from: new Date(T0), to: new Date(T0 + 12 * MINUTE), comment: 'stale' },
        h.by,
      )
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(QualityError);
    expect((stale as QualityError).type).toBe(PROBLEM_TYPES.limitsStale);
    const empty = await h.quality
      .createLimits(
        'leak-rate',
        {
          version: 2,
          from: new Date(T0 + 100 * MINUTE),
          to: new Date(T0 + 200 * MINUTE),
          comment: 'x',
        },
        h.by,
      )
      .catch((error: unknown) => error);
    expect(empty).toMatchObject({ kind: 'invalid' });
    const one = await h.quality
      .createLimits(
        'leak-rate',
        {
          version: 2,
          from: new Date(T0 + 7 * MINUTE),
          to: new Date(T0 + 7 * MINUTE),
          comment: 'x',
        },
        h.by,
      )
      .catch((error: unknown) => error);
    expect(one).toMatchObject({ kind: 'invalid' });
    h.clock.now = T0 + 12 * MINUTE + 30_000;
    const created = await h.quality.createLimits(
      'leak-rate',
      {
        version: 2,
        from: new Date(T0 + 7 * MINUTE),
        to: new Date(T0 + 12 * MINUTE),
        comment: 'new process',
      },
      h.by,
    );
    expect(created.limits).toMatchObject({
      version: 2,
      createdAt: h.clock.now,
      from: { epoch: E1, at: h.clock.now, seq: 0 },
      comment: 'new process',
    });
    expect(created.limits.limits.counts).toEqual({ readings: 6, movingRanges: 5, subgroups: 3 });
    expect(created.limits.capability?.cpk).toEqual(created.limits.capability?.cpu);
    // A later reading is judged by version 2, earlier ones keep version 1.
    await h.cycle(13, 2.0);
    await h.tick();
    const view = await h.quality.chart('leak-rate');
    expect(view?.chart.points.I.map((p) => p.version)).toEqual([
      ...Array.from({ length: 12 }, () => 1),
      2,
    ]);
    h.clock.now += MINUTE;
    const ended = await h.quality.endLimits(
      'leak-rate',
      2,
      { version: created.characteristic.version, comment: 'back to 1' },
      h.by,
    );
    expect(ended.limits).toMatchObject({ version: 2, endedAt: h.clock.now, endedBy: 'quinn' });
    const again = await h.quality
      .endLimits('leak-rate', 2, { version: ended.characteristic.version, comment: 'x' }, h.by)
      .catch((error: unknown) => error);
    expect(again).toMatchObject({ kind: 'conflict' });
    const unknown = await h.quality
      .endLimits('leak-rate', 9, { version: ended.characteristic.version, comment: 'x' }, h.by)
      .catch((error: unknown) => error);
    expect(unknown).toMatchObject({ kind: 'not-found' });
    const audit = await Identity.auditEntries(h.db, 'control_limit', ['leak-rate/2']);
    expect(audit.map((a) => [a.action, a.username, a.authenticated])).toEqual([
      ['spc.limits-end', 'quinn', true],
      ['spc.limits-create', 'quinn', true],
    ]);
    // Append-only: the events are all there, in order.
    const events = await h.db
      .selectFrom('quality.control_limit')
      .select(['n', 'kind', 'version', 'actor'])
      .orderBy('n')
      .execute();
    expect(events).toEqual([
      { n: 1, kind: 'created', version: 1, actor: 'system' },
      { n: 2, kind: 'created', version: 2, actor: 'quinn' },
      { n: 3, kind: 'ended', version: 2, actor: 'quinn' },
    ]);
    await expect(
      h.quality.createLimits(
        'nope',
        { version: 1, from: new Date(T0), to: new Date(T0), comment: 'x' },
        h.by,
      ),
    ).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('acknowledges an episode once, with the row version, audited', async () => {
    const h = await harness('ack');
    for (const [i, value] of BASELINE.entries()) await h.cycle(i + 1, value);
    await h.cycle(7, 2.5);
    await h.tick();
    const [signal] = await h.signals();
    if (!signal) throw new Error('no signal');
    const stale = await h.quality
      .acknowledge(signal.id, { version: signal.rowVersion + 1, comment: 'x' }, h.by)
      .catch((error: unknown) => error);
    expect((stale as QualityError).type).toBe(PROBLEM_TYPES.signalStale);
    const acked = await h.quality.acknowledge(
      signal.id,
      { version: signal.rowVersion, comment: 'checked the tester' },
      h.by,
    );
    expect(acked).toMatchObject({
      rowVersion: signal.rowVersion + 1,
      acknowledged: { by: 'quinn', comment: 'checked the tester', plantAt: new Date(T0) },
    });
    const twice = await h.quality
      .acknowledge(signal.id, { version: acked.rowVersion, comment: 'again' }, h.by)
      .catch((error: unknown) => error);
    expect(twice).toMatchObject({ kind: 'conflict' });
    await expect(
      h.quality.acknowledge(999, { version: 1, comment: 'x' }, h.by),
    ).rejects.toMatchObject({ kind: 'not-found' });
    const audit = await Identity.auditEntries(h.db, 'spc_signal', [String(signal.id)]);
    expect(audit).toMatchObject([{ action: 'spc.ack', username: 'quinn', authenticated: true }]);
    expect(h.changes.at(-1)).toMatchObject({ type: 'signal', event: 'acknowledged' });
    // The acknowledgement survives the episode's growth and a restart.
    await h.cycle(8, 2.0);
    await h.restart();
    const [kept] = await h.signals();
    expect(kept).toMatchObject({
      id: signal.id,
      closedBy: { seq: 8 },
      acknowledged: { by: 'quinn' },
    });
    expect(await h.signals()).toHaveLength(3);
  });
});

describe('quality: the API (#200)', () => {
  it('serves characteristics, the chart, measurements and signals, and takes the writes', async () => {
    const h = await harness('api');
    for (const [i, value] of BASELINE.entries()) await h.cycle(i + 1, value);
    await h.cycle(7, 2.5);
    await h.cycle(8, 2.0);
    await h.cycle(9, 3.4, { result: 'rework' });
    await h.cycle(10, 2.0, { partId: 9 });
    await h.tick();
    const identity = new Identity({ db: h.db, sweepMs: 0, hashParams: { N: 1024, r: 8, p: 1 } });
    await identity.start();
    cleanups.push(() => {
      identity.stop();
      return Promise.resolve();
    });
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity,
      auth: true,
      userWriteRate: { perSecond: 1e6, burst: 1e6 },
      writeRate: { perSecond: 1e6, burst: 1e6 },
    });
    cleanups.push(() => http.app.close());
    const none = () => () => undefined;
    await http.realtime.attach({
      masterData: new MasterData(h.db),
      equipment: {
        currentStates: () => [],
        currentState: () => undefined,
        onChange: none,
        watermark: () => undefined,
        watermarks: () => [],
      },
      ingest: { onStored: none, telemetryMetrics: () => Promise.resolve([]) },
      oee: { workCenters: () => Promise.resolve([]), onChange: none },
      coding: {},
      quality: h.quality,
    } as unknown as ApiSources);
    const HOST = 'localhost:4700';
    const headers = { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' };
    const login = await http.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers,
      payload: { username: 'quinn', password: 'a-long-test-password' },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    const request = (method: 'GET' | 'POST', url: string, body?: unknown) =>
      http.app.inject({
        method,
        url,
        headers: { ...headers, cookie },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    const get = async (url: string) => {
      const response = await request('GET', url);
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
      return response.json<unknown>();
    };
    const list = characteristicListSchema.parse(await get('/api/v1/quality/characteristics'));
    expect(list.characteristics).toMatchObject([
      {
        id: 'leak-rate',
        currentLimits: 1,
        baseline: { needed: 6, final: 9 },
        signals: { open: 4, unacknowledged: 5 },
        notice: null,
      },
    ]);
    const one = characteristicSchema.parse(await get('/api/v1/quality/characteristics/leak-rate'));
    expect(one.version).toBe(2);
    const chart = spcChartSchema.parse(
      await get('/api/v1/quality/characteristics/leak-rate/chart'),
    );
    expect(chart.readings).toEqual({ firstPass: 9, retests: 1 });
    expect(chart.points.I.map((p) => [p.partId, p.value.steps, p.rules])).toContainEqual([
      7,
      '2500/1',
      [1],
    ]);
    expect(chart.limits[0]?.charts.I.centre.steps).toBe('2000/1');
    expect(chart.retests.map((r) => [r.partId, r.pass, r.steps])).toEqual([[9, 2, 2000]]);
    expect(chart.subgroups).toEqual({ complete: 4, pending: 1, dropped: 0 });
    expect(chart.finalThrough).toMatchObject({ epoch: E1, seq: 10 });
    const cut = spcChartSchema.parse(
      await get(
        `/api/v1/quality/characteristics/leak-rate/chart?from=${new Date(T0 + 7 * MINUTE).toISOString()}&to=${new Date(T0 + 8 * MINUTE).toISOString()}`,
      ),
    );
    expect(cut.points.I.map((p) => p.partId)).toEqual([7]);
    const measurements = measurementListSchema.parse(
      await get('/api/v1/quality/characteristics/leak-rate/measurements'),
    );
    expect(measurements.measurements).toHaveLength(10);
    const signals = spcSignalListSchema.parse(await get('/api/v1/quality/signals?status=final'));
    expect(signals.signals.map((s) => [s.chart, s.first.partId, s.ruleText])).toContainEqual([
      'I',
      7,
      'one point beyond a control limit',
    ]);
    expect(
      spcSignalListSchema.parse(
        await get('/api/v1/quality/signals?characteristic=leak-rate&unacknowledged=true'),
      ).signals,
    ).toHaveLength(5);
    const target = signals.signals.find((s) => s.chart === 'I');
    const ack = await request('POST', `/api/v1/quality/signals/${String(target?.id)}/ack`, {
      version: target?.rowVersion,
      comment: 'ok',
    });
    expect(ack.statusCode, ack.body).toBe(200);
    expect(spcSignalSchema.parse(ack.json())).toMatchObject({ acknowledged: { by: 'quinn' } });
    const staleAck = await request('POST', `/api/v1/quality/signals/${String(target?.id)}/ack`, {
      version: target?.rowVersion,
      comment: 'ok',
    });
    expect([staleAck.statusCode, staleAck.json<{ type: string }>().type]).toEqual([
      409,
      PROBLEM_TYPES.signalStale,
    ]);
    const created = await request('POST', '/api/v1/quality/characteristics/leak-rate/limits', {
      version: one.version,
      from: new Date(T0).toISOString(),
      to: new Date(T0 + 8 * MINUTE).toISOString(),
      comment: 're-estimated',
    });
    expect(created.statusCode, created.body).toBe(200);
    const result = limitsWriteResultSchema.parse(created.json());
    expect(result.limits).toMatchObject({ version: 2, createdBy: 'quinn' });
    const stale = await request('POST', '/api/v1/quality/characteristics/leak-rate/limits', {
      version: one.version,
      from: new Date(T0).toISOString(),
      to: new Date(T0 + 8 * MINUTE).toISOString(),
      comment: 're-estimated',
    });
    expect([stale.statusCode, stale.json<{ type: string }>().type]).toEqual([
      409,
      PROBLEM_TYPES.limitsStale,
    ]);
    const ended = await request('POST', '/api/v1/quality/characteristics/leak-rate/limits/2/end', {
      version: result.characteristic.version,
      comment: 'undo',
    });
    expect(ended.statusCode, ended.body).toBe(200);
    expect(
      (
        await request('POST', '/api/v1/quality/characteristics/leak-rate/limits', {
          version: 99,
          from: 'x',
          to: 'y',
          comment: '',
        })
      ).statusCode,
    ).toBe(400);
    expect((await request('GET', '/api/v1/quality/characteristics/nope')).statusCode).toBe(404);
    expect((await request('GET', '/api/v1/quality/characteristics/nope/chart')).statusCode).toBe(
      404,
    );
    expect(
      (await request('GET', '/api/v1/quality/characteristics/nope/measurements')).statusCode,
    ).toBe(404);
    const empty = await request('POST', '/api/v1/quality/characteristics/leak-rate/limits', {
      version: 4,
      from: new Date(T0 + 500 * MINUTE).toISOString(),
      to: new Date(T0 + 600 * MINUTE).toISOString(),
      comment: 'nothing there',
    });
    expect(empty.statusCode, empty.body).toBe(422);
  });

  it('seeds the characteristics of quality.yaml with the leak test’s unit, resolution and limit', () => {
    expect(characteristicsOf(plant)).toEqual([
      {
        id: 'leak-rate',
        name: 'Leak rate (pressure decay)',
        equipment: 'lkt-01',
        operation: 'OP40',
        unit: plant.process.leakTest.unit,
        resolution: plant.process.leakTest.resolution,
        upperSpec: plant.process.leakTest.upperLimit,
        subgroupSize: 5,
        baselineSubgroups: 20,
        rules: { I: [1, 2, 5], MR: [], Xbar: [1, 2, 5], R: [1] },
      },
    ]);
  });
});

describe('quality: pure parts (#200)', () => {
  it('counts passes after reworks in plant-time order, ties by sequence', () => {
    expect(
      passesOf([
        { seq: 9, at: 30, result: 'good' },
        { seq: 2, at: 10, result: 'rework' },
        { seq: 5, at: 20, result: 'rework' },
      ]),
    ).toEqual(
      new Map([
        [2, 1],
        [5, 2],
        [9, 3],
      ]),
    );
  });

  const ref = (seq: number) => ({ epoch: 1, partId: seq, pass: 1, at: seq * 1_000, seq });
  const derived = (
    seq: number,
    final: boolean,
    extra: Partial<DerivedSignal> = {},
  ): DerivedSignal => ({
    version: 1,
    chart: 'I',
    rule: 1,
    first: ref(seq),
    last: ref(seq),
    points: 1,
    closedBy: null,
    baseline: false,
    final,
    ...extra,
  });

  it('plans inserts, updates, withdrawals and deletes; a final episode never goes back', () => {
    const stored = [
      { id: 1, ...derived(1, true), status: 'final' as const, acknowledged: false },
      { id: 2, ...derived(2, false), status: 'provisional' as const, acknowledged: false },
      { id: 3, ...derived(3, false), status: 'provisional' as const, acknowledged: true },
      { id: 4, ...derived(4, true), status: 'final' as const, acknowledged: false },
      { id: 5, ...derived(5, false), status: 'withdrawn' as const, acknowledged: true },
      { id: 6, ...derived(6, false), status: 'provisional' as const, acknowledged: false },
    ];
    const plan = planSignals(
      [
        derived(1, false, { closedBy: ref(2) }),
        derived(5, false),
        derived(6, true),
        derived(7, false),
      ],
      stored,
    );
    expect(plan.inserts.map((s) => s.first.seq)).toEqual([7]);
    expect(plan.updates.map((u) => [u.id, u.status, u.statusChanged, u.event])).toEqual([
      [1, 'final', false, 'updated'],
      [5, 'provisional', true, 'updated'],
      [6, 'final', true, 'final'],
    ]);
    expect(plan.withdrawals).toEqual([
      { id: 3, reason: WITHDRAWN_PROVISIONAL },
      { id: 4, reason: WITHDRAWN_FINAL },
    ]);
    expect(plan.deletes).toEqual([2]);
  });

  it('folds limit events into versions and refuses an end without its version', () => {
    expect(() =>
      versionsOf([
        {
          n: 1,
          kind: 'ended',
          version: 1,
          plantAt: 0,
          position: { epoch: 1, at: 0, seq: 0 },
          limits: null,
          comment: null,
          actor: 'x',
        },
      ]),
    ).toThrow(RangeError);
  });
});
