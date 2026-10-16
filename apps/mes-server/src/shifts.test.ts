/**
 * The `shifts` module (#144, ADR-0025): shift instances as records (created as the plant clock
 * enters a shift, idempotent across restarts), report finality and the composite revision
 * `{ inputs, content }`, handover notes with versions, 409s, the handover window and the
 * append-only audit, and the API with ADR-0023's write guards and the `shifts` push topic. The
 * modules the report reads are fakes here, so every input's finality and revision is set by the
 * test; the golden reconciliation (`reconcile.test-support.ts`) runs the real ones.
 */
import { EventEmitter } from 'node:events';
import { kpisOfBucket, prepare, type BadActor } from '@shopfloor/alarm-core';
import { oeeFromTotals, sumTotals } from '@shopfloor/oee-core';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { shiftKeyAt } from '@shopfloor/shift-calendar';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { buildMesHttp } from './http.ts';
import type {
  AlarmEvent,
  AlarmKpiBucket,
  AlarmKpiQuery,
  AlarmOccurrence,
  AlarmPoint,
} from './modules/alarms/index.ts';
import type {
  CodingChange,
  DowntimeRecord,
  StateHour,
  StoredInterval,
} from './modules/equipment/index.ts';
import { PLANT_CONFIG, freshDatabase } from './modules/equipment/test-support.ts';
import { MasterData } from './modules/master-data/index.ts';
import type { OeeBucket, OeeChange } from './modules/oee/index.ts';
import { PushHub, type ApiSources, type PushSocket } from './modules/realtime/index.ts';
import {
  handoverAuditSchema,
  handoverNotesSchema,
  noteResultSchema,
  problemSchema,
  serverMessageSchema,
  shiftRecordSchema,
  shiftReportSchema,
  type ServerMessage,
} from './modules/realtime/schemas.ts';
import {
  MAX_NOTES,
  ShiftError,
  Shifts,
  handoverWindow,
  isNewer,
  production,
  revisionSteps,
  type ShiftChange,
  type ShiftRecord,
  type ShiftsSources,
} from './modules/shifts/index.ts';
import { startDatabase } from './testing.ts';

const E1 = 1_760_000_000;
const HOUR = 3_600_000;
/** Monday 2026-10-12: shift A is 03:00-11:00Z, B 11:00-19:00Z, C 19:00-03:00Z (Istanbul). */
const at = (time: string, day = 12): number => Date.parse(`2026-10-${String(day)}T${time}:00.000Z`);

const HOST = 'localhost:4700';
const ORIGIN = `http://${HOST}`;
const JSON_WRITE = { host: HOST, origin: ORIGIN, 'content-type': 'application/json' };

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
const databases: Kysely<Database>[] = [];
const modules: Shifts[] = [];
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
}, 180_000);

afterAll(async () => {
  for (const app of apps) await app.close();
  for (const module of modules) await module.stop();
  for (const db of databases) await db.destroy();
  await container.stop();
});

/**
 * Fake sources: one machine (cnc-01) in one work center and the plant as the only alarm scope.
 * Finality and revisions of every input are set by the test; listeners are called by it.
 */
function fakes() {
  const state = {
    clock: at('12:00'),
    epochStart: at('03:00'),
    oeeFinal: false,
    recordsProvisional: false,
    alarmFinal: false,
    /** `{hourIso}` → revision of cnc-01's hour. */
    oeeRevisions: new Map<string, number>(),
    /** `{hourIso}` → revision of the plant's alarm KPI hour. */
    alarmRevisions: new Map<string, number>(),
    cycles: [
      { product: 'VB-100', result: 'good' as const, count: 40 },
      { product: 'VB-100', result: 'scrap' as const, count: 2 },
    ],
    /** How often the input revisions were read (one per evaluation of a report's inputs). */
    evaluations: 0,
    /** A newer epoch (a restarted simulator) and its clock, if any. */
    newer: undefined as { epoch: number; clock: number } | undefined,
    /** Runs while a report reads its content (after the notes and the OEE section). */
    duringContent: undefined as (() => Promise<void>) | undefined,
  };
  const listeners = {
    oee: new Set<(change: OeeChange) => void>(),
    alarms: new Set<(change: AlarmEvent) => void>(),
    coding: new Set<(change: CodingChange) => void>(),
  };
  const subscribe =
    <T>(set: Set<(change: T) => void>) =>
    (listener: (change: T) => void) => {
      set.add(listener);
      return () => set.delete(listener);
    };
  const result = oeeFromTotals(sumTotals([]));
  const bucket = (start: number, end: number, key: string): OeeBucket => ({
    scope: 'equipment',
    id: 'cnc-01',
    bucket: 'shift',
    key,
    shiftKey: key,
    start: new Date(start),
    end: new Date(end),
    members: [{ equipment: 'cnc-01', epoch: E1 }],
    stateMs: {
      Running: end - start,
      Stopped: 0,
      Down: 0,
      Setup: 0,
      Idle: 0,
      Starved: 0,
      Blocked: 0,
      PlannedStop: 0,
      Maintenance: 0,
      Off: 0,
    },
    cycles: state.cycles,
    stops: 0,
    result,
    final: state.oeeFinal,
    provisionalMs: 0,
    revision: 0,
    incidents: 0,
  });
  const record = (start: number, end: number): DowntimeRecord => ({
    equipment: 'cnc-01',
    epoch: E1,
    start: new Date(start),
    end: new Date(end),
    intervalStart: new Date(start),
    shiftKey: '2026-10-12/A',
    state: 'Stopped',
    cause: 'jam',
    loss: 'own',
    autoReason: 'UNCODED',
    provisional: state.recordsProvisional,
    codings: [],
    codingVersion: 0,
  });
  const alarmConfig = plant.alarms.kpi;
  const kpis = (query: AlarmKpiQuery): AlarmKpiBucket[] => {
    const from = query.from.getTime();
    const to = query.to.getTime();
    const set = prepare([], { asOf: state.clock }, alarmConfig);
    const make = (key: string, f: number, t: number, revision: number): AlarmKpiBucket => ({
      scope: 'plant',
      id: 'plant',
      bucket: query.bucket,
      key,
      epoch: E1,
      kpis: kpisOfBucket(set, [], { from: f, to: t }),
      final: state.alarmFinal,
      revision,
      incidents: 0,
    });
    if (query.bucket === 'shift') return [make(shiftKeyAt(plant.shifts, from), from, to, 0)];
    return [...state.alarmRevisions].map(([hour, revision]) =>
      make(hour, Date.parse(hour), Date.parse(hour) + HOUR, revision),
    );
  };
  const sources: ShiftsSources = {
    equipment: {
      watermark: (epoch) =>
        epoch === E1
          ? new Date(state.clock)
          : epoch === state.newer?.epoch
            ? new Date(state.newer.clock)
            : undefined,
      watermarks: () => [
        ...(state.newer
          ? [{ epoch: state.newer.epoch, watermark: new Date(state.newer.clock) }]
          : []),
        { epoch: E1, watermark: new Date(state.clock) },
      ],
      downtimeRecords: (query) =>
        Promise.resolve(
          query.from.getTime() === at('03:00')
            ? [record(at('05:00'), at('05:30')), record(at('07:00'), at('08:00'))]
            : [],
        ),
      stateHourly: (from, to) => {
        state.evaluations++;
        const rows: StateHour[] = [];
        for (let hour = from.getTime(); hour < to.getTime(); hour += HOUR) {
          const key = new Date(hour).toISOString();
          rows.push({
            equipment: 'cnc-01',
            epoch: E1,
            hour: new Date(hour),
            shiftKey: '2026-10-12/A',
            state: 'Running',
            ms: HOUR,
            provisionalMs: 0,
            final: state.oeeFinal,
            revision: state.oeeRevisions.get(key) ?? 0,
            incidentIds: [],
          });
        }
        return Promise.resolve(rows);
      },
      intervals: (equipment) =>
        Promise.resolve(
          equipment === 'cnc-01'
            ? [{ start: new Date(state.epochStart) } as unknown as StoredInterval]
            : [],
        ),
    },
    oee: {
      shift: (b) =>
        Promise.resolve({ equipment: [bucket(b.start, b.end, b.key)], workCenters: [] }),
      // The report's last content read: a test may let something happen right there.
      paretoInputs: async () => {
        await state.duringContent?.();
        return { losses: [], stops: [], members: [] };
      },
      reasonCodes: () => Promise.resolve([]),
      config: plant.oee,
      workCenters: () =>
        Promise.resolve([{ id: 'cell-m1', name: 'Cell M1', equipment: ['cnc-01'] }]),
      onChange: subscribe(listeners.oee),
    },
    alarms: {
      scopes: () => [{ scope: 'plant', id: 'plant', name: 'Plant', equipment: ['cnc-01'] }],
      kpis: (query) => Promise.resolve(kpis(query)),
      badActors: () => Promise.resolve({ epoch: E1, actors: [] as BadActor[] }),
      operatorMeasures: (query) => {
        const from = query.from.getTime();
        const to = query.to.getTime();
        return Promise.resolve({
          epoch: E1,
          buckets: [
            {
              key: shiftKeyAt(plant.shifts, from),
              from,
              to,
              raises: 3,
              shelvedRaises: 1,
              annunciatedRaises: 2,
              timeToAck: { count: 2, sumMs: 90_000, maxMs: 60_000 },
              unacknowledgedAtEnd: 1,
              shelvedMs: [{ equipment: 'cnc-01', code: 'COOLANT-PRESSURE', ms: 600_000 }],
              provisional: false,
            },
          ],
        });
      },
      onChange: subscribe(listeners.alarms),
    },
    coding: { onChange: subscribe(listeners.coding) },
  };
  return {
    state,
    sources,
    oeeChanged: (hour: number) => {
      for (const l of listeners.oee) {
        l({ equipment: 'cnc-01', epoch: E1, from: new Date(hour), to: new Date(hour + HOUR) });
      }
    },
    alarmFinality: () => {
      for (const l of listeners.alarms) l({ type: 'finality', equipment: 'cnc-01', epoch: E1 });
    },
    /** An occurrence raised at `raisedAt` and cleared a minute later was stored (or changed). */
    alarmStored: (raisedAt: number) => {
      const occurrence = {
        epoch: E1,
        raisedAt: new Date(raisedAt),
        endedAt: new Date(raisedAt + 60_000),
      } as unknown as AlarmOccurrence;
      for (const l of listeners.alarms) l({ type: 'occurrence', event: 'cleared', occurrence });
    },
    /** An operator action on an occurrence raised at `raisedAt` (#143). */
    operated: (raisedAt: number, event: 'acknowledged' | 'commented' | 'shelf') => {
      const occurrence = {
        epoch: E1,
        raisedAt: new Date(raisedAt),
        endedAt: null,
      } as unknown as AlarmOccurrence;
      for (const l of listeners.alarms) l({ type: 'occurrence', event, occurrence });
    },
    /** A point's shelf changed (#143). */
    shelved: () => {
      const point = { equipment: 'cnc-01', code: 'COOLANT-PRESSURE' } as unknown as AlarmPoint;
      for (const l of listeners.alarms) l({ type: 'point', event: 'shelved', point });
    },
    coded: (from: number, to: number, kind: 'coded' | 'clipped') => {
      for (const l of listeners.coding) {
        l({ equipment: 'cnc-01', epoch: E1, from: new Date(from), to: new Date(to), kind });
      }
    },
  };
}

async function setup(prefix: string, recheckMs = 0) {
  const db = await freshDatabase(serverUrl, prefix);
  databases.push(db);
  const fake = fakes();
  const changes: ShiftChange[] = [];
  const create = async () => {
    const shifts = new Shifts({
      db,
      ...fake.sources,
      shiftPattern: plant.shifts,
      tickMs: 3_600_000,
      recheckMs,
    });
    modules.push(shifts);
    shifts.onChange((change) => changes.push(change));
    await shifts.start();
    return shifts;
  };
  return { db, fake, changes, create, shifts: await create() };
}

const keys = async (db: Kysely<Database>) =>
  (
    await db
      .selectFrom('shifts.shift_instance')
      .select(['epoch', 'shift_key', 'status'])
      .orderBy('start_time')
      .execute()
  ).map((r) => `${String(r.epoch)} ${r.shift_key} ${r.status}`);

describe('shift instances as records (#144)', () => {
  it('creates the shifts the plant clock entered, from the epoch’s first fact, idempotently', async () => {
    const { db, fake, changes, create, shifts } = await setup('instances');
    // Clock Monday 12:00Z: A has ended, B is running; C has not begun.
    expect(await keys(db)).toEqual([
      `${String(E1)} 2026-10-12/A ended`,
      `${String(E1)} 2026-10-12/B running`,
    ]);
    const a = await shifts.instance('2026-10-12', 'A');
    expect(a).toMatchObject({
      epoch: E1,
      key: '2026-10-12/A',
      start: new Date(at('03:00')),
      end: new Date(at('11:00')),
      breaks: [{ start: new Date(at('07:00')), end: new Date(at('07:30')) }],
      revision: { inputs: 0, content: 0 },
    });
    expect(changes.filter((c) => c.type === 'instance' && c.event === 'created')).toHaveLength(2);

    // A restarted MES finds the rows; creating is idempotent.
    await shifts.stop();
    const again = await create();
    expect(await keys(db)).toHaveLength(2);

    // Exactly at 19:00:00.000 shift C has not begun (the instant before the watermark); B ended.
    fake.state.clock = at('19:00');
    await again.tick();
    expect(await keys(db)).toEqual([
      `${String(E1)} 2026-10-12/A ended`,
      `${String(E1)} 2026-10-12/B ended`,
    ]);
    fake.state.clock = at('19:00') + 1;
    await again.tick();
    expect((await keys(db)).at(-1)).toBe(`${String(E1)} 2026-10-12/C running`);
    expect(changes.some((c) => c.type === 'instance' && c.event === 'status')).toBe(true);
    expect(await again.instance('2026-10-12', 'C', E1 + 1)).toBeUndefined();
  });
});

describe('report finality and the composite revision (ADR-0025)', () => {
  it('is final when its inputs are; inputs counts every input revision after that', async () => {
    const { fake, shifts } = await setup('revision');
    const report = async () => {
      const found = await shifts.report('2026-10-12', 'A');
      if (!found) throw new Error('no report');
      return found;
    };
    // Ended, but OEE and alarms are not final yet.
    expect((await report()).instance.status).toBe('ended');
    fake.state.oeeFinal = true;
    fake.state.alarmFinal = true;
    fake.state.recordsProvisional = true;
    await shifts.tick();
    expect((await shifts.instance('2026-10-12', 'A'))?.status).toBe('ended');
    fake.state.recordsProvisional = false;
    // A late fact revised an hour before the report became final: that is the baseline, not 1.
    fake.state.oeeRevisions.set(new Date(at('04:00')).toISOString(), 1);
    await shifts.tick();
    const final = await shifts.instance('2026-10-12', 'A');
    expect(final).toMatchObject({ status: 'final', revision: { inputs: 0, content: 0 } });
    expect(final?.finalAt).toBeInstanceOf(Date);

    // A late fact after final: one OEE hour revised.
    fake.state.oeeRevisions.set(new Date(at('05:00')).toISOString(), 1);
    fake.oeeChanged(at('05:00'));
    await shifts.tick();
    expect((await shifts.instance('2026-10-12', 'A'))?.revision).toEqual({ inputs: 1, content: 0 });
    // Two inputs at once (an OEE hour and an alarm hour) count two, never one.
    fake.state.oeeRevisions.set(new Date(at('06:00')).toISOString(), 1);
    fake.state.alarmRevisions.set(new Date(at('06:00')).toISOString(), 1);
    fake.alarmStored(at('06:10'));
    await shifts.tick();
    expect((await shifts.instance('2026-10-12', 'A'))?.revision.inputs).toBe(3);
    // The same hour revised twice more: two steps.
    fake.state.oeeRevisions.set(new Date(at('05:00')).toISOString(), 3);
    // Not told: the report's own read brings the counter up to date.
    const read = await report();
    expect(read.instance.revision).toEqual({ inputs: 5, content: 0 });
    expect(read.instance.status).toBe('final');
    // Final never goes back, and nothing new counts nothing.
    fake.state.oeeFinal = false;
    fake.oeeChanged(at('05:00'));
    await shifts.tick();
    expect((await shifts.instance('2026-10-12', 'A'))?.revision).toEqual({ inputs: 5, content: 0 });
    expect((await shifts.instance('2026-10-12', 'A'))?.status).toBe('final');
  });

  it('content rises with every note write and every operator recode inside a final shift', async () => {
    const { fake, shifts, changes } = await setup('content');
    fake.state.oeeFinal = true;
    fake.state.alarmFinal = true;
    await shifts.tick();
    const note = await shifts.createNote(E1, '2026-10-12/A', {
      author: 'Ayşe',
      text: 'Coolant low on CNC-01',
      category: 'equipment',
    });
    await shifts.editNote(E1, '2026-10-12/A', note.id, {
      author: 'Mehmet',
      text: 'Coolant topped up',
      category: 'equipment',
      retracted: false,
      version: 1,
    });
    expect((await shifts.instance('2026-10-12', 'A'))?.revision).toEqual({ inputs: 0, content: 2 });
    // An operator recode inside the final shift A: +1; a clip after a re-cut: none; a recode in
    // the running shift B: none (its report is not final).
    fake.coded(at('05:00'), at('05:30'), 'coded');
    fake.coded(at('05:00'), at('05:30'), 'clipped');
    fake.coded(at('11:30'), at('11:40'), 'coded');
    await shifts.tick();
    expect((await shifts.instance('2026-10-12', 'A'))?.revision).toEqual({ inputs: 0, content: 3 });
    expect((await shifts.instance('2026-10-12', 'B'))?.revision).toEqual({ inputs: 0, content: 0 });
    expect(
      changes.filter((c) => c.type === 'instance' && c.event === 'revised').length,
    ).toBeGreaterThanOrEqual(3);
    expect(changes.flatMap((c) => (c.type === 'note' ? [c.event] : []))).toEqual([
      'created',
      'edited',
    ]);
  });

  it('counts an acknowledgement after final as content; shelves, comments and early acks not', async () => {
    const { fake, shifts } = await setup('operator');
    // Before final: an acknowledgement of a raise in shift A changes nothing stored.
    fake.operated(at('05:00'), 'acknowledged');
    fake.state.oeeFinal = true;
    fake.state.alarmFinal = true;
    await shifts.tick();
    expect((await shifts.instance('2026-10-12', 'A'))?.revision).toEqual({ inputs: 0, content: 0 });
    // After final: an acknowledgement of a raise in A is one content step (its time to
    // acknowledge changes); a raise in B (running), a comment, a shelf flag and a point's shelf
    // (at the plant clock, after A) are none.
    fake.operated(at('05:00'), 'acknowledged');
    fake.operated(at('10:59'), 'acknowledged');
    fake.operated(at('11:00'), 'acknowledged');
    fake.operated(at('05:00'), 'commented');
    fake.operated(at('05:00'), 'shelf');
    fake.shelved();
    await shifts.tick();
    expect((await shifts.instance('2026-10-12', 'A'))?.revision).toEqual({ inputs: 0, content: 2 });
    expect((await shifts.instance('2026-10-12', 'B'))?.revision).toEqual({ inputs: 0, content: 0 });
    // The figures are in the report, not an input of its finality.
    const report = await shifts.report('2026-10-12', 'A');
    expect(report?.alarms[0]?.operator).toMatchObject({
      key: '2026-10-12/A',
      shelvedRaises: 1,
      annunciatedRaises: 2,
      timeToAck: { count: 2, sumMs: 90_000, maxMs: 60_000 },
      unacknowledgedAtEnd: 1,
    });
    expect(report?.instance.status).toBe('final');
  });

  it('composes the report: production, uncoded time, the longest records, notes with history', async () => {
    const { shifts } = await setup('report');
    await shifts.createNote(E1, '2026-10-12/A', {
      author: 'Ayşe',
      text: 'Fixture 3 worn',
      category: 'quality',
    });
    const report = await shifts.report('2026-10-12', 'A');
    expect(report?.production).toEqual({
      machines: [
        {
          equipment: 'cnc-01',
          produced: 42,
          good: 40,
          scrap: 2,
          rework: 0,
          cycles: [
            { product: 'VB-100', result: 'good', count: 40 },
            { product: 'VB-100', result: 'scrap', count: 2 },
          ],
        },
      ],
      finished: { equipment: 'cnc-01', good: 40 },
      scrap: 2,
    });
    expect(report?.downtime.records).toBe(2);
    expect(report?.downtime.uncodedMs).toBe(90 * 60_000);
    expect(report?.downtime.longest.map((r) => r.start)).toEqual([
      new Date(at('07:00')),
      new Date(at('05:00')),
    ]);
    expect(report?.notes.map((n) => [n.note.text, n.history.map((h) => h.action)])).toEqual([
      ['Fixture 3 worn', ['created']],
    ]);
    expect(report?.alarms.map((s) => [s.scope.id, s.kpis?.key])).toEqual([
      ['plant', '2026-10-12/A'],
    ]);
    expect(await shifts.report('2026-10-13', 'A')).toBeUndefined();
  });
});

describe('handover notes: versions, the handover window and the audit (ADR-0023)', () => {
  it('refuses a stale version, a foreign shift, and a write outside the handover window', async () => {
    const { db, fake, shifts } = await setup('notes');
    const note = await shifts.createNote(E1, '2026-10-12/A', {
      author: 'Ayşe',
      text: 'Check the washer filter',
      category: 'general',
    });
    expect(note).toMatchObject({ version: 1, retracted: false, createdBy: 'Ayşe' });
    expect(note.createdPlantAt).toEqual(new Date(fake.state.clock));
    const edit = {
      author: 'Mehmet',
      text: 'Wrong machine',
      category: 'general' as const,
      retracted: true,
      version: 1,
    };
    const retracted = await shifts.editNote(E1, '2026-10-12/A', note.id, edit);
    expect(retracted).toMatchObject({ version: 2, retracted: true, author: 'Mehmet' });
    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => 'accepted',
        (error: unknown) => (error instanceof ShiftError ? error.kind : String(error)),
      );
    expect(await refusal(shifts.editNote(E1, '2026-10-12/A', note.id, edit))).toBe('conflict');
    expect(await refusal(shifts.editNote(E1, '2026-10-12/B', note.id, edit))).toBe('not-found');
    expect(
      await refusal(shifts.createNote(E1 + 1, '2026-10-12/A', { ...edit, category: 'general' })),
    ).toBe('not-found');

    // Shift A's notes can be written until the end of shift B (19:00Z), plant time.
    expect(
      handoverWindow(plant.shifts, { start: new Date(at('03:00')), end: new Date(at('11:00')) }),
    ).toEqual({
      from: at('03:00'),
      to: at('19:00'),
    });
    fake.state.clock = at('19:00');
    expect(
      await refusal(
        shifts.createNote(E1, '2026-10-12/A', { author: 'x', text: 'late', category: 'safety' }),
      ),
    ).toBe('conflict');
    expect(
      await refusal(shifts.editNote(E1, '2026-10-12/A', note.id, { ...edit, version: 2 })),
    ).toBe('conflict');
    // Shift B's are still open.
    fake.state.clock = at('19:00') - 1;
    await shifts.createNote(E1, '2026-10-12/B', { author: 'x', text: 'ok', category: 'safety' });

    // The history: both versions, newest first, unauthenticated, with plant time.
    const audit = await shifts.noteAudit(note.id);
    expect(
      audit.map((e) => [e.action, e.before?.retracted ?? null, e.after.retracted, e.version]),
    ).toEqual([
      ['edited', false, true, 2],
      ['created', null, false, 1],
    ]);
    expect(audit.every((e) => !e.authenticated && e.plantAt instanceof Date)).toBe(true);

    // Append-only audit; notes are never deleted.
    for (const statement of [
      sql`UPDATE shifts.handover_audit SET actor = 'someone'`,
      sql`DELETE FROM shifts.handover_audit`,
      sql`TRUNCATE shifts.handover_audit`,
      sql`DELETE FROM shifts.handover_note`,
      sql`TRUNCATE shifts.handover_note CASCADE`,
    ]) {
      await expect(statement.execute(db)).rejects.toThrow(/append-only|never deleted/);
    }
  });

  it('counts revision steps per input and production per machine', () => {
    expect(revisionSteps({ a: 1, b: 0 }, { a: 3, b: 1, c: 2 })).toBe(5);
    expect(revisionSteps({ a: 3 }, { a: 1 })).toBe(0);
    expect(
      production({
        id: 'x',
        cycles: [{ product: 'p', result: 'rework', count: 3 }],
      }),
    ).toMatchObject({ produced: 3, good: 0, rework: 3 });
  });
});

describe('evaluation load, read order, concurrency and epochs (#144 review)', () => {
  const finalAB = async (prefix: string) => {
    const context = await setup(prefix, 3_600_000);
    const { fake, shifts } = context;
    fake.state.oeeFinal = true;
    fake.state.alarmFinal = true;
    fake.state.clock = at('19:00') + 1; // A and B ended, C running
    await shifts.tick(); // B ends and is evaluated: final
    fake.alarmFinality(); // A, ended since the start, is evaluated again: final
    await shifts.tick();
    expect((await shifts.instance('2026-10-12', 'A'))?.status).toBe('final');
    expect((await shifts.instance('2026-10-12', 'B'))?.status).toBe('final');
    return context;
  };

  it('evaluates a final report only when an input in its range may have changed', async () => {
    const { fake, shifts, create } = await finalAB('load');
    const evaluated = () => fake.state.evaluations;
    const before = evaluated();
    // Finality moves (nearly every fact) concern only reports not final yet: none here.
    for (let i = 0; i < 20; i++) fake.alarmFinality();
    await shifts.tick();
    expect(evaluated()).toBe(before);
    // An OEE change of 05:00 reaches shift A only; an occurrence at 12:00-12:01 shift B only.
    fake.oeeChanged(at('05:00'));
    await shifts.tick();
    expect(evaluated()).toBe(before + 1);
    fake.alarmStored(at('12:00'));
    await shifts.tick();
    expect(evaluated()).toBe(before + 2);
    // At start-up only reports not final are evaluated (C is running: none).
    await shifts.stop();
    const restarted = await create();
    expect(evaluated()).toBe(before + 2);
    await restarted.tick();
    expect(evaluated()).toBe(before + 2);
  });

  it('serves a revision that never leads its content', async () => {
    const { fake, shifts } = await finalAB('order');
    // An input is revised while the report reads its content, after the revisions were read:
    // this read shows `inputs` 0, the next one the step.
    fake.state.duringContent = () => {
      fake.state.oeeRevisions.set(new Date(at('05:00')).toISOString(), 1);
      return Promise.resolve();
    };
    expect((await shifts.report('2026-10-12', 'A'))?.instance.revision.inputs).toBe(0);
    fake.state.duringContent = undefined;
    expect((await shifts.report('2026-10-12', 'A'))?.instance.revision.inputs).toBe(1);
    // A note written while the report reads its content (after its notes): not in this report,
    // so neither is its `content` step.
    fake.state.clock = at('12:00');
    fake.state.duringContent = async () => {
      fake.state.duringContent = undefined;
      await shifts.createNote(E1, '2026-10-12/A', {
        author: 'Ayşe',
        text: 'Written meanwhile',
        category: 'general',
      });
    };
    const first = await shifts.report('2026-10-12', 'A');
    expect([first?.notes.length, first?.instance.revision.content]).toEqual([0, 0]);
    const second = await shifts.report('2026-10-12', 'A');
    expect([second?.notes.length, second?.instance.revision.content]).toEqual([1, 1]);
  });

  it('counts a step once when reports are read concurrently, and pushes only newer revisions', async () => {
    const { fake, shifts, changes } = await finalAB('concurrent');
    fake.state.oeeRevisions.set(new Date(at('06:00')).toISOString(), 2);
    const reads = await Promise.all(
      Array.from({ length: 5 }, () => shifts.report('2026-10-12', 'A')),
    );
    expect(reads.every((r) => (r?.instance.revision.inputs ?? 0) <= 2)).toBe(true);
    expect((await shifts.instance('2026-10-12', 'A'))?.revision.inputs).toBe(2);
    // Every push of shift A carries a revision at least as new as the one before.
    const pushed = changes.flatMap((c) =>
      c.type === 'instance' && c.instance.key === '2026-10-12/A' ? [c.instance.revision] : [],
    );
    for (const [i, revision] of pushed.entries()) {
      const previous = pushed[i - 1];
      if (previous) {
        expect(revision.inputs).toBeGreaterThanOrEqual(previous.inputs);
        expect(revision.content).toBeGreaterThanOrEqual(previous.content);
      }
    }
    expect(pushed.at(-1)?.inputs).toBe(2);
    const kept: ShiftRecord | undefined = reads[0]?.instance;
    if (!kept) throw new Error('no report');
    const older = { ...kept, revision: { inputs: 1, content: 0 } };
    const newer = { ...kept, revision: { inputs: 2, content: 0 } };
    expect([isNewer(older, newer), isNewer(newer, older), isNewer(newer, newer)]).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('keeps epochs apart and closes the handover of an older epoch', async () => {
    const { fake, shifts } = await setup('epochs');
    const E2 = E1 + 1;
    // Shift B of E1 is open for notes at 12:00 …
    await shifts.createNote(E1, '2026-10-12/B', { author: 'a', text: 'E1', category: 'general' });
    // … until a restarted simulator (E2) replays the day.
    fake.state.newer = { epoch: E2, clock: at('12:00') };
    await shifts.tick();
    expect((await shifts.instance('2026-10-12', 'B'))?.epoch).toBe(E2);
    expect((await shifts.instance('2026-10-12', 'B', E1))?.status).toBe('ended');
    const closed = await shifts
      .createNote(E1, '2026-10-12/B', { author: 'a', text: 'late', category: 'general' })
      .catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(ShiftError);
    expect((closed as ShiftError).message).toMatch(/handover closed: epoch/);
    await shifts.createNote(E2, '2026-10-12/B', { author: 'a', text: 'E2', category: 'general' });
    expect((await shifts.notes(E1, '2026-10-12/B', false)).map((n) => n.note.text)).toEqual(['E1']);
    expect((await shifts.notes(E2, '2026-10-12/B', false)).map((n) => n.note.text)).toEqual(['E2']);
    expect((await shifts.report('2026-10-12', 'B', E1))?.instance.epoch).toBe(E1);
  });

  it('refuses the 201st note of a shift', async () => {
    const { shifts } = await setup('limit');
    for (let i = 0; i < MAX_NOTES; i++) {
      await shifts.createNote(E1, '2026-10-12/A', {
        author: 'a',
        text: `note ${String(i)}`,
        category: 'general',
      });
    }
    const refused = await shifts
      .createNote(E1, '2026-10-12/A', { author: 'a', text: 'one more', category: 'general' })
      .catch((error: unknown) => error);
    expect([(refused as ShiftError).kind, (refused as ShiftError).message]).toEqual([
      'invalid',
      'at most 200 notes per shift',
    ]);
    expect((await shifts.instance('2026-10-12', 'A'))?.revision.content).toBe(MAX_NOTES);
  });

  it('takes ?epoch on a note write', async () => {
    const context = await setup('api_epoch');
    const front = await api(context);
    const app = await front(true);
    context.fake.state.newer = { epoch: E1 + 1, clock: at('12:00') };
    await context.shifts.tick();
    const post = (epoch: number) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/shifts/2026-10-12/B/notes?epoch=${String(epoch)}`,
        headers: JSON_WRITE,
        payload: { author: 'a', text: 'x', category: 'general' },
      });
    const newer = await post(E1 + 1);
    expect(newer.statusCode).toBe(200);
    expect(noteResultSchema.parse(newer.json()).note.epoch).toBe(E1 + 1);
    expect((await post(E1)).statusCode).toBe(409);
    expect((await post(E1 + 2)).statusCode).toBe(404);
  });
});

/** An MES HTTP front over the fakes and a real `Shifts`, with or without writes. */
async function api({
  db,
  fake,
  shifts,
}: Awaited<ReturnType<typeof setup>>): Promise<(writes: boolean) => Promise<FastifyInstance>> {
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const none = () => () => undefined;
  const sources = {
    masterData,
    equipment: {
      ...fake.sources.equipment,
      currentStates: () => [],
      currentState: () => undefined,
      onChange: none,
    },
    ingest: { onStored: none, telemetryMetrics: () => Promise.resolve([]) },
    oee: {
      ...fake.sources.oee,
      shiftPattern: plant.shifts,
      current: () => Promise.resolve({ hour: null, shift: null }),
    },
    coding: {},
    shifts,
  } as unknown as ApiSources;
  return async (writes) => {
    const http = await buildMesHttp({ ready: () => Promise.resolve(true), writes });
    await http.realtime.attach(sources);
    apps.push(http.app);
    return http.app;
  };
}

describe('the shifts API and push (#144)', () => {
  it('serves the instance, report and notes; writes pass the guards; push sends upserts', async () => {
    const context = await setup('api');
    const { fake, shifts } = context;
    const front = await api(context);
    const app = await front(true);
    const get = async (url: string) =>
      app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { host: HOST } });

    const instance = await get('/shifts/2026-10-12/A');
    expect(instance.statusCode).toBe(200);
    expect(shiftRecordSchema.parse(instance.json())).toMatchObject({
      key: '2026-10-12/A',
      epoch: E1,
      status: 'ended',
      final: false,
    });
    expect((await get('/shifts/2026-10-12/Z')).statusCode).toBe(404);
    expect((await get('/shifts/2026-10-13/A')).statusCode).toBe(404);
    expect((await get(`/shifts/2026-10-12/A?epoch=${String(E1 + 1)}`)).statusCode).toBe(404);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/shifts/2026-10-12/A/notes',
      headers: JSON_WRITE,
      payload: { author: 'Ayşe', text: 'Fixture 3 worn', category: 'quality' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.headers['x-request-id']).toBeTruthy();
    const body = noteResultSchema.parse(created.json());
    expect(body.shift.revision).toEqual({ inputs: 0, content: 1 });
    const edit = (version: number) =>
      app.inject({
        method: 'PUT',
        url: `/api/v1/shifts/2026-10-12/A/notes/${String(body.note.id)}`,
        headers: JSON_WRITE,
        payload: {
          author: 'Mehmet',
          text: 'Fixture 3 replaced',
          category: 'quality',
          retracted: false,
          version,
        },
      });
    expect((await edit(1)).statusCode).toBe(200);
    const stale = await edit(1);
    expect(stale.statusCode).toBe(409);
    expect(problemSchema.parse(stale.json()).detail).toMatch(/version is 2/);
    const elsewhere = await app.inject({
      method: 'PUT',
      url: `/api/v1/shifts/2026-10-12/B/notes/${String(body.note.id)}`,
      headers: JSON_WRITE,
      payload: { author: 'x', text: 'y', category: 'quality', retracted: false, version: 2 },
    });
    expect(elsewhere.statusCode).toBe(404);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/shifts/2026-10-12/A/notes',
      headers: JSON_WRITE,
      payload: { author: 'Ayşe', text: '', category: 'gossip' },
    });
    expect(invalid.statusCode).toBe(400);

    // ADR-0023's guards, unchanged: no Origin, a foreign one, a form, a cross-site fetch.
    const payload = { author: 'x', text: 'y', category: 'general' };
    const url = '/api/v1/shifts/2026-10-12/A/notes';
    const refused = await Promise.all([
      app.inject({
        method: 'POST',
        url,
        headers: { host: HOST, 'content-type': 'application/json' },
        payload,
      }),
      app.inject({
        method: 'POST',
        url,
        headers: { ...JSON_WRITE, origin: 'http://evil.example' },
        payload,
      }),
      app.inject({
        method: 'POST',
        url,
        headers: { ...JSON_WRITE, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'author=x&text=y&category=general',
      }),
      app.inject({
        method: 'POST',
        url,
        headers: { ...JSON_WRITE, 'sec-fetch-site': 'cross-site' },
        payload,
      }),
    ]);
    expect(refused.map((r) => r.statusCode)).toEqual([403, 403, 415, 403]);
    const off = await front(false);
    expect(
      (await off.inject({ method: 'POST', url, headers: JSON_WRITE, payload })).statusCode,
    ).toBe(405);
    // Nothing refused was written.
    expect((await shifts.notes(E1, '2026-10-12/A', false)).length).toBe(1);

    // Outside the handover window: 409.
    fake.state.clock = at('19:00');
    const closed = await app.inject({ method: 'POST', url, headers: JSON_WRITE, payload });
    expect(closed.statusCode).toBe(409);
    expect(problemSchema.parse(closed.json()).detail).toMatch(/handover closed/);

    const notes = handoverNotesSchema.parse((await get('/shifts/2026-10-12/A/notes')).json());
    expect(notes.notes.map((n) => [n.note.version, n.history.length])).toEqual([[2, 2]]);
    const audit = handoverAuditSchema.parse(
      (await get(`/shifts/2026-10-12/A/notes/${String(body.note.id)}/audit`)).json(),
    );
    expect(audit.entries.map((e) => [e.action, e.after.text, e.requestId !== null])).toEqual([
      ['edited', 'Fixture 3 replaced', true],
      ['created', 'Fixture 3 worn', true],
    ]);

    const report = await get('/shifts/2026-10-12/A/report');
    expect(report.statusCode).toBe(200);
    const parsed = shiftReportSchema.parse(report.json());
    expect(parsed).toMatchObject({
      key: '2026-10-12/A',
      final: false,
      revision: { inputs: 0, content: 2 },
      production: { finished: { equipment: 'cnc-01', good: 40 }, scrap: 2 },
      downtime: { records: 2, uncodedMs: 90 * 60_000 },
    });
    // The OEE section is the body of /shifts/{date}/{shift}/oee, byte for byte.
    const oee = await get('/shifts/2026-10-12/A/oee');
    expect(JSON.stringify(report.json<{ oee: unknown }>().oee)).toBe(oee.body);
    expect(parsed.generatedAt).toMatch(/Z$/);
  });

  it('pushes instance and note upserts on the `shifts` topic', () => {
    const listeners = new Set<(change: ShiftChange) => void>();
    const hub = new PushHub({ heartbeatMs: 3_600_000, clockMs: 3_600_000 });
    const sent: ServerMessage[] = [];
    const emitter = new EventEmitter();
    const socket = Object.assign(emitter, {
      bufferedAmount: 0,
      send: (data: string) => {
        sent.push(serverMessageSchema.parse(JSON.parse(data)));
      },
      ping: () => undefined,
      close: () => undefined,
      terminate: () => undefined,
    }) as unknown as PushSocket;
    hub.attach({
      equipment: {
        currentStates: () => [],
        watermark: () => undefined,
        watermarks: () => [],
        onChange: () => () => undefined,
      },
      ingest: { onStored: () => () => undefined, telemetryMetrics: () => Promise.resolve([]) },
      catalog: new Set(),
      shifts: {
        onChange: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    hub.connect(socket);
    emitter.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'subscribe', topic: 'shifts' })),
      false,
    );
    const record = {
      epoch: E1,
      key: '2026-10-12/A',
      date: '2026-10-12',
      shift: 'A',
      start: new Date(at('03:00')),
      end: new Date(at('11:00')),
      breaks: [],
      status: 'final' as const,
      finalAt: new Date(),
      revision: { inputs: 0, content: 1 },
    };
    for (const listener of listeners)
      listener({ type: 'instance', event: 'revised', instance: record });
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(sent.map((m) => m.type)).toEqual(['subscribed', 'shift']);
        expect(sent[1]).toMatchObject({
          event: 'revised',
          shift: { key: '2026-10-12/A', final: true },
        });
        hub.close();
        resolve();
      });
    });
  });
});
