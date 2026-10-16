/**
 * Test support: reconciliation with the simulator's headless ground truth (#96; plan
 * "Reconciliation", exit criteria 1 and 2 without the broker). The headless simulator runs as a process (apps never
 * import each other), its event log becomes the UNS messages the gateway would publish, and they
 * go through ingest's store path into TimescaleDB. Time per state, per machine and shift bucket,
 * must equal the ground truth to the millisecond; so must the hourly aggregates (#118), per machine
 * and hour, against the ground truth's OEE inputs (`oee.machines.*.hours`, sim-summary/2).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { EquipmentPath, MachineState } from '@shopfloor/contracts';
import { HOUR, availabilityLoss } from '@shopfloor/oee-core';
import { UNCODED, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { NO_SHIFT, shiftSegments } from '@shopfloor/shift-calendar';
import type { Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cycleHourly,
  cycleHourlyRaw,
  fractionalPieces,
  stateHourly,
  stateHourlyRaw,
} from '../../db/aggregates.test-support.ts';
import type { Database } from '../../db/database.ts';
import { startDatabase } from '../../testing.ts';
import { Ingest } from '../ingest/index.ts';
import { MasterData } from '../master-data/index.ts';
import { Equipment, downtimeRules } from './index.ts';
import {
  PLANT_CONFIG,
  UnsFeed,
  freshDatabase,
  random,
  shuffle,
  storedPieces,
  type Delivery,
} from './test-support.ts';

const REPO = resolve(import.meta.dirname, '../../../../..');
const HEADLESS = join(REPO, 'apps/simulator/src/headless/cli.ts');
const GOLDEN = join(REPO, 'apps/simulator/golden/week-01');
const EPOCH = 1_760_000_000;

interface SimEvent {
  readonly type: string;
  readonly at: string;
  readonly machineId?: string;
  readonly to?: MachineState;
  readonly cause?: string;
  readonly product?: string;
  readonly partId?: number;
  readonly serial?: string;
  readonly result?: 'good' | 'scrap' | 'rework';
  readonly reason?: string;
  readonly measurement?: {
    characteristic: string;
    value: number;
    unit: string;
    upperLimit: number;
  };
  readonly code?: string;
  readonly transition?: 'active' | 'cleared';
  readonly severity?: number;
}

type StateMs = Record<string, number>;

/** One hour of a machine's OEE inputs in the ground truth (#117). */
interface TruthHour {
  readonly shift: string;
  readonly stateMs: StateMs;
  readonly cycles: readonly { product: string; result: string; count: number }[];
}

interface GroundTruth {
  readonly machines: Record<string, { stateMs: StateMs; byShift: Record<string, StateMs> }>;
  readonly oee: {
    readonly machines: Record<string, { readonly hours: Record<string, TruthHour> }>;
  };
}

interface Run {
  readonly start: number;
  readonly end: number;
  readonly events: SimEvent[];
  readonly truth: GroundTruth;
  readonly summaryText: string;
}

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
const databases: Kysely<Database>[] = [];
const runs: string[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
}, 180_000);

afterAll(async () => {
  for (const db of databases) await db.destroy();
  for (const dir of runs) await rm(dir, { recursive: true, force: true });
  await container.stop();
});

/** Runs the headless simulator (its CLI, as a process) and reads its event log and summary. */
async function headless(seed: number, start: string, days: number): Promise<Run> {
  const out = await mkdtemp(join(tmpdir(), 'headless-'));
  runs.push(out);
  await promisify(execFile)(process.execPath, [
    HEADLESS,
    '--seed',
    String(seed),
    '--start',
    start,
    '--days',
    String(days),
    '--out',
    out,
  ]);
  const [lines, summaryText] = await Promise.all([
    readFile(join(out, 'events.jsonl'), 'utf8'),
    readFile(join(out, 'summary.json'), 'utf8'),
  ]);
  const [header, ...rest] = lines.trimEnd().split('\n');
  const run = JSON.parse(header ?? '{}') as { start: string; end: string };
  return {
    start: Date.parse(run.start),
    end: Date.parse(run.end),
    events: rest.map((line) => JSON.parse(line) as SimEvent),
    truth: JSON.parse(summaryText) as GroundTruth,
    summaryText,
  };
}

/**
 * The UNS messages the gateway publishes for a run (docs/contracts/uns.md "Sources"): one snapshot
 * per machine at connect (every machine starts Off), then each state change, cycle and alarm with
 * the machine's own sequence (shared by its three fact topics, as OPC UA `Sequence` and the
 * washer's ring are), all in the simulator's single epoch. WSH-01's telemetry carries the
 * simulation clock; one sample at the end is the watermark the run is observed up to.
 */
function unsMessages(run: Run): { facts: Delivery[]; anchors: Delivery[]; end: Delivery } {
  const paths = new Map<string, EquipmentPath>();
  for (const area of plant.plant.areas) {
    for (const workCenter of area.workCenters) {
      for (const item of workCenter.equipment) {
        paths.set(item.id, { area: area.id, workCenter: workCenter.id, equipment: item.id });
      }
    }
  }
  const feed = new UnsFeed(paths);
  const anchors = [...paths.keys()].map((id) => feed.snapshot(id, EPOCH, run.start, 'Off'));
  const seqs = new Map<string, number>();
  const facts: Delivery[] = [];
  for (const event of run.events) {
    const machine = event.machineId;
    if (!machine || !['state', 'cycle-complete', 'alarm'].includes(event.type)) continue;
    const seq = (seqs.get(machine) ?? 0) + 1;
    seqs.set(machine, seq);
    const at = Date.parse(event.at);
    if (event.type === 'state') {
      facts.push(feed.state(machine, EPOCH, seq, at, event.to ?? 'Idle', event.cause ?? null));
    } else if (event.type === 'cycle-complete') {
      facts.push(
        feed.cycle(machine, EPOCH, seq, at, {
          product: event.product ?? '',
          partId: event.partId ?? 0,
          serial: event.serial ?? '',
          result: event.result ?? 'good',
          reason: event.reason ?? null,
          measurement: event.measurement ?? null,
        }),
      );
    } else {
      facts.push(
        feed.alarm(
          machine,
          EPOCH,
          seq,
          at,
          event.code ?? '',
          event.transition ?? 'active',
          event.severity ?? 1,
        ),
      );
    }
  }
  return { facts, anchors, end: feed.telemetry('wsh-01', run.end, EPOCH) };
}

/**
 * A fresh database with master data, ingest (no broker) and the equipment module. Both refresh
 * their hourly aggregate as in production (debounced 1 s, in the background, while the replay runs).
 */
async function mes(): Promise<{
  db: Kysely<Database>;
  equipment: Equipment;
  ingest: Ingest;
  send: (deliveries: readonly Delivery[]) => Promise<void>;
}> {
  const db = await freshDatabase(serverUrl, 'reconcile');
  databases.push(db);
  const masterData = new MasterData(db);
  await masterData.seed(plant);
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'unused',
    refresh: {},
  });
  // A replay: store open intervals at boundaries only, not every simulated minute.
  const equipment = new Equipment({
    db,
    source: ingest,
    shiftPattern: plant.shifts,
    provisionalStepMs: HOUR,
    refresh: {},
    downtime: downtimeRules(plant),
  });
  await equipment.start();
  return {
    db,
    equipment,
    ingest,
    send: async (deliveries) => {
      for (const d of deliveries) await ingest.deliver(d.topic, d.payload);
    },
  };
}

/**
 * The hourly aggregates (#118), once the pending refreshes ran: equal to the raw pieces and cycles;
 * per machine and hour equal to the ground truth's OEE inputs (state ms, cycles by product and
 * result, shift bucket), for every hour of the run; Σ hours = shift; every final hour refreshed.
 */
async function expectAggregates(
  equipment: Equipment,
  ingest: Ingest,
  db: Kysely<Database>,
  run: Run,
) {
  await equipment.refreshAggregates();
  await ingest.refreshAggregates();
  expect(await fractionalPieces(db)).toBe(0);
  expect(await stateHourly(db)).toEqual(await stateHourlyRaw(db));
  expect(await cycleHourly(db)).toEqual(await cycleHourlyRaw(db));

  const from = new Date(run.start);
  const to = new Date(run.end);
  interface Entry {
    shift: string;
    stateMs: StateMs;
    cycles: { product: string; result: string; count: number }[];
  }
  const actual: Record<string, Record<string, Entry>> = {};
  const byShift: Record<string, Record<string, StateMs>> = {};
  const finals = new Set<string>();
  for (const row of await equipment.stateHourly(from, to, { epoch: EPOCH })) {
    const hour = row.hour.toISOString();
    const machine = (actual[row.equipment] ??= {});
    const entry = (machine[hour] ??= { shift: row.shiftKey, stateMs: {}, cycles: [] });
    expect(entry.shift).toBe(row.shiftKey); // one shift bucket per hour
    entry.stateMs[row.state] = row.ms;
    const shift = ((byShift[row.equipment] ??= {})[row.shiftKey] ??= {});
    shift[row.state] = (shift[row.state] ?? 0) + row.ms;
    if (row.final) finals.add(`${row.equipment} ${hour}`);
  }
  for (const row of await ingest.cycleHourly(from, to, { epoch: EPOCH })) {
    const entry = actual[row.equipment]?.[row.hour.toISOString()];
    if (!entry)
      throw new Error(`cycles without pieces: ${row.equipment} ${row.hour.toISOString()}`);
    entry.cycles.push({
      product: row.product,
      result: row.result,
      count: row.count,
    });
  }
  const order = (a: { product: string; result: string }, b: { product: string; result: string }) =>
    `${a.product} ${a.result}`.localeCompare(`${b.product} ${b.result}`);
  const truth = Object.fromEntries(
    Object.entries(run.truth.oee.machines).map(([machine, { hours }]) => [
      machine,
      Object.fromEntries(
        Object.entries(hours).map(([hour, inputs]) => [
          hour,
          {
            shift: inputs.shift,
            stateMs: Object.fromEntries(Object.entries(inputs.stateMs).filter(([, ms]) => ms > 0)),
            cycles: [...inputs.cycles].sort(order),
          },
        ]),
      ),
    ]),
  );
  for (const machine of Object.values(actual)) {
    for (const entry of Object.values(machine)) entry.cycles.sort(order);
  }
  expect(actual).toEqual(truth);
  // Σ hours = shift: the hourly rows add up to the shift totals, and so to the ground truth.
  expect(byShift).toEqual(expected(run.truth));
  // Every final hour is refreshed, in both aggregates: final for OEE.
  const recorded = await db
    .selectFrom('equipment.bucket_finality')
    .select(['equipment', 'hour'])
    .execute();
  expect([...finals].sort()).toEqual(
    recorded.map((r) => `${r.equipment} ${r.hour.toISOString()}`).sort(),
  );
  expect(recorded.every((r) => ingest.cyclesRefreshed(r.hour))).toBe(true);
  return Object.keys(truth).length;
}

/** Time per state, per machine and shift bucket, from the stored intervals. */
async function totals(equipment: Equipment, db: Kysely<Database>) {
  const keys = await db
    .selectFrom('equipment.equipment_state_interval')
    .select('shift_key')
    .distinct()
    .execute();
  const result: Record<string, Record<string, StateMs>> = {};
  for (const { shift_key: key } of keys) {
    for (const row of await equipment.shiftTotals(key, { epoch: EPOCH })) {
      const machine = (result[row.equipment] ??= {});
      (machine[key] ??= {})[row.state] = row.ms;
    }
  }
  return result;
}

/** The ground truth without zero entries, in the same shape. */
function expected(truth: GroundTruth): Record<string, Record<string, StateMs>> {
  return Object.fromEntries(
    Object.entries(truth.machines).map(([machine, { byShift }]) => [
      machine,
      Object.fromEntries(
        Object.entries(byShift)
          .map(([key, states]) => [
            key,
            Object.fromEntries(Object.entries(states).filter(([, ms]) => ms > 0)),
          ])
          .filter(([, states]) => Object.keys(states as StateMs).length > 0),
      ),
    ]),
  );
}

/** Every stored piece lies inside one UTC hour and one shift bucket of the shared calendar. */
async function expectInsideBuckets(db: Kysely<Database>, run: Run): Promise<number> {
  const segments = shiftSegments(plant.shifts, run.start, run.end);
  const rows = await storedPieces(db);
  for (const row of rows) {
    const from = row.start_time.getTime();
    const to = row.end_time.getTime();
    expect(row.hour.getTime()).toBe(Math.floor(from / HOUR) * HOUR);
    expect(to).toBeLessThanOrEqual(row.hour.getTime() + HOUR);
    const segment = segments.find((s) => s.from <= from && from < s.to);
    expect(segment?.key).toBe(row.shift_key);
    expect(to).toBeLessThanOrEqual(segment?.to ?? -1);
  }
  return rows.length;
}

/**
 * Interval finality (#113). Delivered complete and gap-free, a machine's pieces are final exactly
 * up to its own last fact: every piece ending by then is final, every later one provisional (a
 * machine silent at the end of the run, such as Off over the weekend). Every hour before that has
 * its final row, with no revision and no incident, and so has every shift bucket. Returns the
 * (machine, bucket) pairs still provisional, for the log.
 */
async function expectFinality(equipment: Equipment, db: Kysely<Database>, run: Run) {
  const settled = new Map<string, number>();
  for (const event of run.events) {
    if (event.machineId && ['state', 'cycle-complete', 'alarm'].includes(event.type)) {
      settled.set(event.machineId, Date.parse(event.at));
    }
  }
  const settledOf = (machine: string): number => settled.get(machine) ?? -Infinity;
  const rows = await storedPieces(db);
  const wrong = rows.filter(
    (row) => row.provisional !== row.end_time.getTime() > settledOf(row.equipment),
  );
  expect(wrong).toEqual([]);
  const finals = await db.selectFrom('equipment.bucket_finality').selectAll().execute();
  expect(finals.filter((row) => row.revision !== 0 || row.incident_ids.length > 0)).toEqual([]);
  const hours = (list: readonly { equipment: string; hour: Date }[]) =>
    [...new Set(list.map((row) => `${row.equipment} ${row.hour.toISOString()}`))].sort();
  expect(hours(finals)).toEqual(
    hours(rows.filter((row) => row.hour.getTime() + HOUR <= settledOf(row.equipment))),
  );
  const provisional: string[] = [];
  for (const key of [...new Set(rows.map((row) => row.shift_key))].sort()) {
    for (const row of await equipment.shiftTotals(key, { epoch: EPOCH })) {
      expect([row.revision, row.incidents]).toEqual([0, 0]);
      if (row.provisionalMs > 0) provisional.push(`${row.equipment} ${key} ${row.state}`);
    }
  }
  return provisional;
}

/** Every stored downtime record without the wall-clock column, in key order. */
const storedRecords = (db: Kysely<Database>) =>
  db
    .selectFrom('equipment.downtime_record')
    .select(['equipment', 'epoch', 'start_time', 'end_time', 'interval_start', 'shift_key'])
    .select(['state', 'cause', 'auto_reason', 'provisional'])
    .orderBy('equipment')
    .orderBy('epoch')
    .orderBy('start_time')
    .execute();

/**
 * Downtime records (#119, Phase 5 exit criterion 4): every availability-loss interval of the run,
 * computed here from the event log alone (ADR-0021's loss table, the micro-stop threshold over the
 * whole interval, one record per scheduled shift bucket), has exactly its records, none of them
 * UNCODED, all closed and final. Returns the counts for the log.
 */
async function expectRecords(db: Kysely<Database>, run: Run) {
  const segments = shiftSegments(plant.shifts, run.start, run.end);
  const expectedKeys: string[] = [];
  const byMachine = new Map<string, { at: number; state: string }[]>();
  for (const event of run.events) {
    if (event.type !== 'state' || !event.machineId) continue;
    const list = byMachine.get(event.machineId) ?? [{ at: run.start, state: 'Off' }];
    list.push({ at: Date.parse(event.at), state: event.to ?? 'Idle' });
    byMachine.set(event.machineId, list);
  }
  let lossIntervals = 0;
  for (const [machine, points] of byMachine) {
    points.forEach((point, i) => {
      const end = points[i + 1]?.at ?? run.end;
      if (end <= point.at) return;
      if (!availabilityLoss(point.state, end - point.at, plant.oee.microStopThresholdMs)) return;
      // Inside planned time only: the no-shift bucket has none, so nothing is lost there.
      const keys = segments
        .filter((seg) => seg.key !== NO_SHIFT && seg.to > point.at && seg.from < end)
        .map((seg) => `${machine} ${new Date(Math.max(point.at, seg.from)).toISOString()}`);
      if (keys.length > 0) lossIntervals++;
      expectedKeys.push(...keys);
    });
  }
  const stored = await storedRecords(db);
  expect(stored.map((r) => `${r.equipment} ${r.start_time.toISOString()}`).sort()).toEqual(
    expectedKeys.sort(),
  );
  expect(stored.filter((r) => r.auto_reason === UNCODED)).toEqual([]);
  expect(stored.filter((r) => r.provisional || r.end_time === null)).toEqual([]);
  return { lossIntervals, records: stored.length };
}

/**
 * Per-test limits: the golden week takes about 70 s in order and 125 s shuffled locally. Both
 * limits together (10 min) leave the end-to-end job (20 min, with the gateway's test and the
 * install) room to report a failure rather than be cancelled.
 */
const IN_ORDER_MS = 240_000;
const SHUFFLED_MS = 360_000;

export interface Scenario {
  readonly seed: number;
  /** ISO 8601 with offset, e.g. Monday 06:00 Istanbul. */
  readonly start: string;
  readonly days: number;
  /** The golden scenario this run must reproduce exactly (its summary.json), if any. */
  readonly golden?: string;
}

/** The golden week's scenario (apps/simulator/golden/week-01). */
export async function goldenWeek(): Promise<Scenario> {
  const scenario = JSON.parse(await readFile(join(GOLDEN, 'scenario.json'), 'utf8')) as Scenario;
  return { seed: scenario.seed, start: scenario.start, days: scenario.days, golden: GOLDEN };
}

/**
 * Both reconciliation tests for one simulated span: in-order delivery equals the ground truth
 * per machine and shift bucket to the millisecond, with every piece inside one hour and one shift;
 * shuffled delivery with duplicates stores the very same intervals.
 */
export function reconciliationSuite(title: string, scenario: () => Promise<Scenario>): void {
  describe(title, () => {
    let run: Run;
    let reference: Kysely<Database>;

    it(
      'in order: time per state, per machine and shift, equals the ground truth to the ms',
      async () => {
        const span = await scenario();
        run = await headless(span.seed, span.start, span.days);
        if (span.golden) {
          // The very run the golden snapshot pins.
          expect(run.summaryText).toBe(await readFile(join(span.golden, 'summary.json'), 'utf8'));
        }
        const { facts, anchors, end } = unsMessages(run);
        const { db, equipment, ingest, send } = await mes();
        reference = db;
        await send([...anchors, ...facts, end]);
        expect(equipment.watermark(EPOCH)).toEqual(new Date(run.end));
        expect(await totals(equipment, db)).toEqual(expected(run.truth));
        expect(await expectInsideBuckets(db, run)).toBeGreaterThan(facts.length / 2);
        // Every machine shuts down at the end of the last shift (a state fact at its very end):
        // only the weekend's no-shift bucket, after its last fact, is still provisional.
        const provisional = await expectFinality(equipment, db, run);
        expect(provisional.length).toBeGreaterThan(0);
        expect(provisional.filter((bucket) => !bucket.includes(' no-shift '))).toEqual([]);
        expect(await expectAggregates(equipment, ingest, db, run)).toBe(6);
        const downtime = await expectRecords(db, run);
        expect(downtime.records).toBeGreaterThanOrEqual(downtime.lossIntervals);
        expect(downtime.lossIntervals).toBeGreaterThan(0);
        await equipment.stop();
        await ingest.stop();
      },
      IN_ORDER_MS,
    );

    it(
      'shuffled delivery with duplicates stores identical intervals',
      async () => {
        const { facts, anchors, end } = unsMessages(run);
        const next = random(2026);
        const copies = facts.filter(() => next() < 0.1);
        const mixed = shuffle([...anchors, ...facts, ...copies], next);
        const { db, equipment, ingest, send } = await mes();
        // Telemetry flows all along; the last sample, after every fact, ends the observation.
        await send([...mixed, end, ...mixed.slice(0, 500)]);
        await equipment.flush();
        expect(await storedPieces(db)).toEqual(await storedPieces(reference));
        expect(await storedRecords(db)).toEqual(await storedRecords(reference));
        expect(await totals(equipment, db)).toEqual(expected(run.truth));
        await expectFinality(equipment, db, run);
        // Refreshed in the background all along, while late facts kept changing earlier hours.
        expect(equipment.stateAggregate()?.refreshes).toBeGreaterThan(0);
        expect(await expectAggregates(equipment, ingest, db, run)).toBe(6);
        await equipment.stop();
        await ingest.stop();
      },
      SHUFFLED_MS,
    );
  });
}
