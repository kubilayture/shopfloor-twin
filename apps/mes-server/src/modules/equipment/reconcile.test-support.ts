/**
 * Test support: reconciliation with the simulator's headless ground truth (#96; plan
 * "Reconciliation", exit criteria 1 and 2 without the broker). The headless simulator runs as a process (apps never
 * import each other), its event log becomes the UNS messages the gateway would publish, and they
 * go through ingest's store path into TimescaleDB. Time per state, per machine and shift bucket,
 * must equal the ground truth to the millisecond; so must the hourly aggregates (#118), per machine
 * and hour, against the ground truth's OEE inputs (`oee.machines.*.hours`, sim-summary/2), and the
 * OEE of every machine and work center in every shift bucket (#120, `oee.*.shifts`), exactly; and
 * every alarm occurrence and every alarm KPI per position and plant, per hour and shift bucket,
 * with flood episodes and bad actors (#142, `alarms`, sim-summary/3).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { EquipmentPath, MachineState } from '@shopfloor/contracts';
import { confirmationKey, expandErpDataset, type FeedEntry } from '@shopfloor/contracts/erp-api';
import { HOUR, availabilityLoss, oeeFromTotals, sumTotals } from '@shopfloor/oee-core';
import { UNCODED, idealCycleMs, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { NO_SHIFT, shiftBuckets, shiftInstances, shiftSegments } from '@shopfloor/shift-calendar';
import { attachConsumption } from '@shopfloor/trace-core';
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
import { Alarms, type AlarmKpiBucket, type AlarmScope } from '../alarms/index.ts';
import { Execution } from '../execution/index.ts';
import { Identity, type WriteBy } from '../identity/index.ts';
import { Ingest } from '../ingest/index.ts';
import { MasterData, erpMasterData } from '../master-data/index.ts';
import { Oee, pareto, type OeeBucket } from '../oee/index.ts';
import {
  Orders,
  type CommandPublisher,
  type ErpApi,
  type FeedPage,
  type PostOutcome,
} from '../orders/index.ts';
import {
  alarmKpiDto,
  badActorDto,
  floodEpisodeDto,
  resultDto,
  shiftOeeDto,
} from '../realtime/index.ts';
import { LONGEST_RECORDS, REPORT_BAD_ACTORS, Shifts } from '../shifts/index.ts';
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
const GOLDENS = join(REPO, 'apps/simulator/golden');
const GOLDEN = join(GOLDENS, 'week-01');
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
  readonly transition?: 'active' | 'cleared' | 'accepted' | 'started' | 'completed';
  readonly severity?: number;
  /** Orders mode (#172): job facts and material taken. */
  readonly commandId?: string;
  readonly orderId?: string;
  readonly quantity?: number;
  readonly material?: string;
  /** Traceability (#196, #197): the lot of a `material-consumed`, the operator of an `operator`. */
  readonly lotId?: string;
  readonly operatorId?: string | null;
}

/** Device facts: every one takes the machine's next sequence number (job facts in orders mode). */
const DEVICE_FACTS = ['state', 'cycle-complete', 'alarm', 'job'];

type StateMs = Record<string, number>;

/** One hour of a machine's OEE inputs in the ground truth (#117). */
interface TruthHour {
  readonly shift: string;
  readonly stateMs: StateMs;
  readonly stops: readonly { ms: number; wholeMs: number }[];
  readonly cycles: readonly { product: string; result: string; count: number }[];
}

/** One shift bucket of a machine in the ground truth: `oee-core` inputs and `bucketOee` (#117). */
interface TruthShift {
  readonly inputs: {
    readonly stateMs: StateMs;
    readonly cycles: readonly { product: string; result: string; count: number }[];
  };
  readonly result: unknown;
}

/** The alarm section of the ground truth (#140, sim-summary/3). */
interface AlarmTruth {
  readonly occurrences: readonly unknown[];
  readonly scopes: Record<
    string,
    {
      readonly hours: Record<string, unknown>;
      readonly shifts: Record<string, unknown>;
      readonly floods: readonly unknown[];
      readonly badActors: {
        readonly run: readonly unknown[];
        readonly shifts: Record<string, readonly unknown[]>;
      };
    }
  >;
}

interface GroundTruth {
  readonly alarms: AlarmTruth;
  readonly machines: Record<string, { stateMs: StateMs; byShift: Record<string, StateMs> }>;
  readonly oee: {
    readonly machines: Record<
      string,
      { readonly hours: Record<string, TruthHour>; readonly shifts: Record<string, TruthShift> }
    >;
    readonly workCenters: Record<string, { readonly shifts: Record<string, unknown> }>;
  };
  /** The order part (#172, sim-summary/4): empty in schedule mode. */
  readonly orders: OrdersTruth;
}

/** One order of the ground truth (#172, ADR-0030). */
interface OrderTruth {
  readonly product: string;
  readonly jobs: readonly string[];
  readonly quantity: number;
  readonly started: number;
  readonly scrap: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly reworkPasses: number;
  readonly packedGood: number;
  readonly wip: Readonly<Record<string, number>>;
  readonly completedAt: string | null;
  readonly operations: Readonly<
    Record<string, { in: number; good: number; scrap: number; rework: number }>
  >;
  readonly material: Readonly<Record<string, number>>;
  readonly materialInProcess: Readonly<Record<string, number>>;
}

interface OrdersTruth {
  readonly jobs: readonly { readonly commandId: string; readonly orderId: string }[];
  readonly orders: Readonly<Record<string, OrderTruth>>;
  readonly units: { readonly count: number; readonly sha256: string };
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

/**
 * Runs the headless simulator (its CLI, as a process) and reads its event log and summary: a
 * golden scenario by name (with its injections), or a seed and span.
 */
async function headless(span: Scenario): Promise<Run> {
  const out = await mkdtemp(join(tmpdir(), 'headless-'));
  runs.push(out);
  await promisify(execFile)(process.execPath, [
    HEADLESS,
    ...(span.scenario === undefined
      ? ['--seed', String(span.seed), '--start', span.start, '--days', String(span.days)]
      : ['--scenario', span.scenario]),
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
  // Lots and operator per cycle (UNS contract 1.4, #197): the machine server's very rule, the
  // fold `attachConsumption` of trace-core over the event log (ADR-0033).
  const attached = attachConsumption(run.events);
  for (const [index, event] of run.events.entries()) {
    const machine = event.machineId;
    if (!machine || !DEVICE_FACTS.includes(event.type)) continue;
    const seq = (seqs.get(machine) ?? 0) + 1;
    seqs.set(machine, seq);
    const at = Date.parse(event.at);
    if (event.type === 'state') {
      facts.push(feed.state(machine, EPOCH, seq, at, event.to ?? 'Idle', event.cause ?? null));
    } else if (event.type === 'job') {
      facts.push(
        feed.job(machine, EPOCH, seq, at, {
          transition: (event.transition ?? 'accepted') as 'accepted' | 'started' | 'completed',
          commandId: event.commandId ?? '',
          orderId: event.orderId ?? '',
          product: event.product ?? '',
          quantity: event.quantity ?? 0,
        }),
      );
    } else if (event.type === 'cycle-complete') {
      // WSH-01, a legacy washer on Modbus, reads no serial (its register map), and its ring
      // carries no lots or operator: the gateway sends none of them.
      const modbus = machine.startsWith('wsh');
      const attachment = attached[index];
      facts.push(
        feed.cycle(machine, EPOCH, seq, at, {
          product: event.product ?? '',
          partId: event.partId ?? 0,
          serial: modbus ? '' : (event.serial ?? ''),
          result: event.result ?? 'good',
          reason: event.reason ?? null,
          measurement: event.measurement ?? null,
          ...(modbus || !attachment
            ? {}
            : { lots: attachment.lots, operator: attachment.operator }),
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
          event.transition === 'cleared' ? 'cleared' : 'active',
          event.severity ?? 1,
        ),
      );
    }
  }
  return { facts, anchors, end: feed.telemetry('wsh-01', run.end, EPOCH) };
}

/** What a cycle should carry (UNS contract 1.4), derived from the raw events, not `trace-core`. */
interface ExpectedTrace {
  readonly lots: { material: string; lot: string }[] | undefined;
  readonly operator: string | null | undefined;
}

/**
 * The lots and operator of every cycle, written out from ADR-0033's rule over the raw event log,
 * independently of `trace-core`'s `attachConsumption` (which the harness uses to build the
 * messages, as the machine server does): a part's `material-consumed` events on a machine attach,
 * in order, to its next `cycle-complete` there; the operator is the machine's latest `operator`
 * event before the part's first consumption there (none: null); a cycle that consumed nothing has
 * `[]` and null. WSH-01 (Modbus) reports neither. Also counts the cycles whose machine's operator
 * changed between that start and the cycle's end, where an end-of-cycle rule would differ.
 */
function expectedCycleTraces(run: Run): {
  cycles: Map<string, ExpectedTrace>;
  operatorChanged: number;
} {
  const operators = new Map<string, string | null>();
  const pending = new Map<
    string,
    { lots: { material: string; lot: string }[]; operator: string | null }
  >();
  const cycles = new Map<string, ExpectedTrace>();
  let operatorChanged = 0;
  for (const event of run.events) {
    const machine = event.machineId ?? '';
    const part = `${machine}/${String(event.partId)}`;
    if (event.type === 'operator') {
      operators.set(machine, event.operatorId ?? null);
    } else if (event.type === 'material-consumed') {
      let entry = pending.get(part);
      if (!entry) {
        entry = { lots: [], operator: operators.get(machine) ?? null };
        pending.set(part, entry);
      }
      entry.lots.push({ material: event.material ?? '', lot: event.lotId ?? '' });
    } else if (event.type === 'cycle-complete') {
      const key = `${part}/${String(Date.parse(event.at))}`;
      const entry = pending.get(part);
      pending.delete(part);
      if (machine.startsWith('wsh')) {
        cycles.set(key, { lots: undefined, operator: undefined });
        continue;
      }
      cycles.set(key, entry ?? { lots: [], operator: null });
      if (entry && entry.operator !== (operators.get(machine) ?? null)) operatorChanged++;
    }
  }
  return { cycles, operatorChanged };
}

/**
 * Lots and operator on the stored cycle facts (UNS contract 1.4, #197): every cycle carries what
 * `expectedCycleTraces` derives from the event log, and the lot index finds, per lot, exactly the
 * cycles the event log attaches it to. Returns the lots, the cycles that reported at least one,
 * those with an operator, and those whose operator changed before the cycle ended.
 */
async function expectCycleLots(
  ingest: Ingest,
  run: Run,
): Promise<{
  lots: number;
  tracedCycles: number;
  operatorCycles: number;
  operatorChanged: number;
}> {
  const { cycles: expected, operatorChanged } = expectedCycleTraces(run);
  const perLot = new Map<string, Set<string>>();
  for (const [key, trace] of expected) {
    for (const lot of trace.lots ?? []) {
      perLot.set(lot.lot, (perLot.get(lot.lot) ?? new Set()).add(key));
    }
  }
  const stored = await ingest.cycleFacts({ epoch: EPOCH });
  const actual = new Map(
    stored.map((fact) => [
      `${fact.equipment}/${String(fact.partId)}/${String(fact.sourceTime.getTime())}`,
      { lots: fact.lots, operator: fact.operator },
    ]),
  );
  expect(actual.size).toBe(stored.length);
  expect(actual).toEqual(expected);
  for (const [lot, cycles] of perLot) {
    const found = await ingest.cycleFacts({ epoch: EPOCH, lot });
    expect(
      new Set(
        found.map((f) => `${f.equipment}/${String(f.partId)}/${String(f.sourceTime.getTime())}`),
      ),
      lot,
    ).toEqual(cycles);
  }
  const traced = [...expected.values()];
  return {
    lots: perLot.size,
    tracedCycles: traced.filter((t) => (t.lots?.length ?? 0) > 0).length,
    operatorCycles: traced.filter((t) => typeof t.operator === 'string').length,
    operatorChanged,
  };
}

/**
 * A fresh database with master data, ingest (no broker) and the equipment module. Both refresh
 * their hourly aggregate as in production (debounced 1 s, in the background, while the replay runs).
 */
async function mes(): Promise<{
  db: Kysely<Database>;
  equipment: Equipment;
  ingest: Ingest;
  masterData: MasterData;
  alarms: Alarms;
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
    // Above the run's length (exit criterion 2): no gap of a shuffled replay becomes an incident.
    gapGraceMs: 3_600_000,
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
  // Alarm occurrences follow ingest after the equipment module (#142), as in main.ts.
  const alarms = new Alarms({
    db,
    ingest,
    equipment,
    masterData,
    shiftPattern: plant.shifts,
    config: plant.alarms.kpi,
  });
  await alarms.start();
  return {
    db,
    equipment,
    ingest,
    masterData,
    alarms,
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

/** A bucket's OEE inputs and result as the ground truth writes them (sim-summary/2). */
const bucketJson = (bucket: OeeBucket) => ({
  stateMs: { ...bucket.stateMs },
  cycles: bucket.cycles.map((c) => ({ ...c })),
  result: resultDto(bucket.result),
});

/**
 * OEE (#120, Phase 5 exit criterion 2): for every machine and both work centers, in every shift
 * bucket of the run, the MES's OEE (computed on read by the `oee` module from the aggregates and
 * stop pieces) equals the ground truth exactly: inputs (integer ms per state, cycles per product
 * and result), the A/P/Q/OEE fractions with their four-decimal strings, totals, losses and
 * `unplanned`. Every scheduled bucket is final, with no provisional time, revision or incident;
 * the no-shift bucket's OEE is null on both sides. Then Σ hours = shift for the OEE totals, the
 * stop pieces per hour equal the ground truth's, and the downtime Pareto of every shift equals its
 * availability losses. Returns the number of bucket comparisons.
 */
async function expectOee(
  equipment: Equipment,
  ingest: Ingest,
  masterData: MasterData,
  run: Run,
): Promise<number> {
  // A run that ends with machines running (alarms-01) leaves its last shift provisional: no fact
  // after it tells that nothing more happened before its end (ADR-0018).
  const settledEnd = Math.min(...[...lastFacts(run).values()]);
  const oee = new Oee({
    equipment,
    ingest,
    masterData,
    shiftPattern: plant.shifts,
    config: plant.oee,
    idealCycleMs: idealCycleMs(plant),
  });
  await oee.start();
  const truth = run.truth.oee;
  let comparisons = 0;
  const shiftResults = new Map<string, OeeBucket>();
  for (const bucket of shiftBuckets(plant.shifts, run.start, run.end)) {
    const { equipment: machines, workCenters } = await oee.shift(bucket, EPOCH);
    const scheduled = bucket.key !== NO_SHIFT;
    expect(machines.map((b) => b.id).sort()).toEqual(
      Object.keys(truth.machines)
        .filter((id) => truth.machines[id]?.shifts[bucket.key])
        .sort(),
    );
    expect(workCenters.map((b) => b.id).sort()).toEqual(
      Object.keys(truth.workCenters)
        .filter((id) => truth.workCenters[id]?.shifts[bucket.key])
        .sort(),
    );
    for (const b of machines) {
      const expected = truth.machines[b.id]?.shifts[bucket.key];
      const zeroFree = (states: StateMs) =>
        Object.fromEntries(Object.entries(states).filter(([, ms]) => ms > 0));
      const actual = bucketJson(b);
      expect([b.id, bucket.key, zeroFree(actual.stateMs), actual.cycles, actual.result]).toEqual([
        b.id,
        bucket.key,
        zeroFree(expected?.inputs.stateMs ?? {}),
        expected?.inputs.cycles,
        expected?.result,
      ]);
      shiftResults.set(`${b.id} ${bucket.key}`, b);
      comparisons++;
    }
    for (const b of workCenters) {
      expect([b.id, bucket.key, resultDto(b.result)]).toEqual([
        b.id,
        bucket.key,
        truth.workCenters[b.id]?.shifts[bucket.key],
      ]);
      comparisons++;
    }
    for (const b of [...machines, ...workCenters]) {
      if (scheduled && bucket.end <= settledEnd) {
        expect([b.id, bucket.key, b.final, b.provisionalMs, b.revision, b.incidents]).toEqual([
          b.id,
          bucket.key,
          true,
          0,
          0,
          0,
        ]);
      } else if (!scheduled) {
        expect([b.result.availability, b.result.oee]).toEqual([null, null]);
      }
    }
  }

  for (const machine of Object.keys(truth.machines)) {
    // Σ hours = shift: the hour buckets' totals add up to the shift bucket's, per shift.
    const hours = await oee.buckets({
      scope: 'equipment',
      id: machine,
      bucket: 'hour',
      from: new Date(run.start),
      to: new Date(run.end),
      epoch: EPOCH,
    });
    const byShift = new Map<string, OeeBucket[]>();
    for (const hour of hours)
      byShift.set(hour.shiftKey, [...(byShift.get(hour.shiftKey) ?? []), hour]);
    for (const [key, list] of byShift) {
      const summed = oeeFromTotals(sumTotals(list.map((hour) => hour.result.totals)));
      expect([machine, key, resultDto(summed)]).toEqual([
        machine,
        key,
        resultDto(shiftResults.get(`${machine} ${key}`)?.result ?? summed),
      ]);
      expect(shiftResults.has(`${machine} ${key}`)).toBe(true);
    }
    // The stop pieces per hour, with their whole interval's length, equal the ground truth's.
    const pieces = await equipment.stopPieces(new Date(run.start), new Date(run.end), {
      equipment: machine,
      epoch: EPOCH,
    });
    const actual: Record<string, [number, number][]> = {};
    for (const piece of pieces) {
      (actual[piece.hour.toISOString()] ??= []).push([
        piece.end.getTime() - piece.start.getTime(),
        piece.wholeMs,
      ]);
    }
    const expected: Record<string, [number, number][]> = {};
    for (const [hour, inputs] of Object.entries(truth.machines[machine]?.hours ?? {})) {
      if (inputs.stops.length > 0) expected[hour] = inputs.stops.map((s) => [s.ms, s.wholeMs]);
    }
    const sorted = (map: Record<string, [number, number][]>) =>
      Object.fromEntries(
        Object.entries(map).map(([hour, list]) => [
          hour,
          [...list].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
        ]),
      );
    expect([machine, sorted(actual)]).toEqual([machine, sorted(expected)]);
  }

  // The Pareto of every scheduled shift: reasons never change OEE, so the record time by loss
  // equals the shift's availability losses, and the micro-stops by cause sum to its micro-stops.
  const reasons = await oee.reasonCodes();
  for (const [key, bucket] of shiftResults) {
    const [machine = ''] = key.split(' ');
    if (bucket.shiftKey === NO_SHIFT) continue;
    const read = await oee.paretoInputs('equipment', machine, bucket.start, bucket.end, EPOCH);
    const loss = pareto({
      ...read,
      from: bucket.start,
      to: bucket.end,
      thresholdMs: plant.oee.microStopThresholdMs,
      reasons,
    });
    const losses = bucket.result.losses;
    expect([key, loss.availability, loss.microStops.reduce((sum, m) => sum + m.ms, 0)]).toEqual([
      key,
      {
        own: Number(losses?.availability.own.total ?? 0n),
        external: Number(losses?.availability.external.total ?? 0n),
      },
      Number(losses?.performance.microStops ?? 0n),
    ]);
  }
  oee.stop();
  // Not vacuous: one comparison per (machine or work center, shift bucket) of the ground truth.
  const expected =
    Object.values(truth.machines).reduce((n, m) => n + Object.keys(m.shifts).length, 0) +
    Object.values(truth.workCenters).reduce((n, wc) => n + Object.keys(wc.shifts).length, 0);
  expect(expected).toBeGreaterThan(0);
  expect(comparisons).toBe(expected);
  return comparisons;
}

/** The time of each machine's last device fact (state, cycle or alarm). */
function lastFacts(run: Run): Map<string, number> {
  const last = new Map<string, number>();
  for (const event of run.events) {
    if (event.machineId && DEVICE_FACTS.includes(event.type)) {
      last.set(event.machineId, Date.parse(event.at));
    }
  }
  return last;
}

const floorHour = (at: number): number => Math.floor(at / HOUR) * HOUR;
const ceilHour = (at: number): number => Math.ceil(at / HOUR) * HOUR;

/** A KPI bucket in the ground truth's shape (`AlarmKpisJson`): the MES's own fields left out. */
function truthShape(bucket: AlarmKpiBucket): unknown {
  const dto = alarmKpiDto(bucket);
  return {
    from: dto.from,
    to: dto.to,
    raises: dto.raises,
    byPriority: dto.byPriority,
    averageRate: dto.averageRate,
    windows: dto.windows,
    peak10: dto.peak10,
    floodWindows: dto.floodWindows,
    floods: dto.floods,
    floodMs: dto.floodMs,
    activeAtEnd: dto.activeAtEnd,
    standing: dto.standing.map(({ equipment, code, raisedAt }) => ({ equipment, code, raisedAt })),
    chatteringRaises: dto.chatteringRaises,
    chatteringPoints: dto.chatteringPoints,
    fleeting: dto.fleeting,
    fleetingUndecided: dto.fleetingUndecided,
    activeMs: dto.activeMs,
    provisional: dto.provisional,
  };
}

/**
 * Alarms (#142, Phase 6 exit criterion 2): every occurrence equals the ground truth (equipment,
 * code, priority, severity, raise and clear to the ms, end reason, in raise order); for the plant
 * and every position, every hour and shift bucket's KPIs, the flood episodes and the bad actors of
 * the run and of every shift bucket equal it exactly. Every bucket has revision 0 and no incident,
 * and is final once each machine of its scope reported past its end plus fleetingMs (a machine's
 * last fact bounds what is final: the weekend after the last shift, or the end of a run that
 * stops mid-shift). Returns the comparisons and the buckets not final.
 */
async function expectAlarms(
  alarms: Alarms,
  run: Run,
): Promise<{ compared: number; final: number; open: string[] }> {
  const truth = run.truth.alarms;
  const all = [
    // The four views partition the occurrences (#143), whatever operators did.
    ...(await alarms.list({ view: 'active', limit: 100_000 })),
    ...(await alarms.list({ view: 'acknowledged', limit: 100_000 })),
    ...(await alarms.list({ view: 'shelved', limit: 100_000 })),
    ...(await alarms.list({ view: 'history', limit: 100_000 })),
  ].sort(
    (a, b) =>
      a.raisedAt.getTime() - b.raisedAt.getTime() ||
      (a.equipment < b.equipment ? -1 : a.equipment > b.equipment ? 1 : 0) ||
      a.seq - b.seq,
  );
  expect(
    all.map((o) => ({
      equipment: o.equipment,
      code: o.code,
      priority: o.priority,
      severity: o.severity,
      raisedAt: o.raisedAt.toISOString(),
      clearedAt: o.endedAt?.toISOString() ?? null,
      endReason: o.endReason,
    })),
  ).toEqual(truth.occurrences);
  let compared = all.length;
  let final = 0;
  const open: string[] = [];
  const last = lastFacts(run);
  const from = new Date(run.start);
  const to = new Date(run.end);
  const runRange = { from: floorHour(run.start), to: ceilHour(run.end) };
  // The MES has exactly the ground truth's scopes: the plant and the configured positions.
  expect(
    alarms
      .scopes()
      .filter((s) => s.scope !== 'equipment')
      .map((s) => s.id)
      .sort(),
  ).toEqual(Object.keys(truth.scopes).sort());
  for (const [id, expected] of Object.entries(truth.scopes)) {
    const scope: AlarmScope = id === 'plant' ? 'plant' : 'position';
    const members = alarms.scope(scope, id)?.equipment ?? [];
    expect(members.length).toBeGreaterThan(0);
    const settled = Math.min(...members.map((m) => last.get(m) ?? -Infinity));
    const query = { scope, id, from, to, epoch: EPOCH };
    const hours = await alarms.kpis({ ...query, bucket: 'hour' });
    const shifts = await alarms.kpis({ ...query, bucket: 'shift' });
    expect(Object.fromEntries(hours.map((b) => [b.key, truthShape(b)]))).toEqual(expected.hours);
    expect(Object.fromEntries(shifts.map((b) => [b.key, truthShape(b)]))).toEqual(expected.shifts);
    compared += hours.length + shifts.length;
    for (const b of [...hours, ...shifts]) {
      expect([id, b.key, b.revision, b.incidents]).toEqual([id, b.key, 0, 0]);
      const end = b.kpis.to;
      expect([id, b.key, b.final]).toEqual([
        id,
        b.key,
        end + plant.alarms.kpi.fleetingMs <= settled,
      ]);
      if (b.final) final++;
      else open.push(`${id} ${b.key}`);
    }
    const floods = await alarms.floods(query);
    expect(floods.episodes.map(floodEpisodeDto)).toEqual(expected.floods);
    const run10 = await alarms.badActors({
      ...query,
      from: new Date(runRange.from),
      to: new Date(runRange.to),
      limit: 10,
    });
    expect(run10.actors.map(badActorDto)).toEqual(expected.badActors.run);
    compared += 2;
    for (const shift of shifts) {
      const actors = await alarms.badActors({
        ...query,
        from: new Date(shift.kpis.from),
        to: new Date(shift.kpis.to),
        limit: 10,
      });
      expect([id, shift.key, actors.actors.map(badActorDto)]).toEqual([
        id,
        shift.key,
        expected.badActors.shifts[shift.key],
      ]);
      compared++;
    }
    expect(Object.keys(expected.badActors.shifts).sort()).toEqual(shifts.map((s) => s.key).sort());
  }
  return { compared, final, open };
}

/**
 * Shift reports (#144, Phase 6 exit criterion 4): one `shift_instance` per scheduled shift of the
 * run, with the calendar's start, end and breaks, also after a restart. For every shift: the
 * report's OEE section equals `GET /shifts/{date}/{shift}/oee` byte for byte and the ground truth;
 * per machine, produced, good, scrap and rework equal the OEE inputs and the ground truth;
 * finished parts are PCK-01's good cycles; the downtime Pareto sums to the own plus external
 * availability loss; per scope the alarm section equals `GET /alarms/kpi` for the shift and the
 * ground truth, with the top 5 bad actors. The report is final exactly when its inputs are, then
 * with `revision.inputs = 0` (and `content = 0`: nothing was written). Returns the comparisons
 * and the shifts final.
 */
async function expectShiftReports(
  db: Kysely<Database>,
  equipment: Equipment,
  ingest: Ingest,
  masterData: MasterData,
  alarms: Alarms,
  run: Run,
): Promise<{ compared: number; shifts: number; final: number }> {
  const oee = new Oee({
    equipment,
    ingest,
    masterData,
    shiftPattern: plant.shifts,
    config: plant.oee,
    idealCycleMs: idealCycleMs(plant),
  });
  await oee.start();
  const create = async () => {
    const shifts = new Shifts({
      db,
      equipment,
      oee,
      alarms,
      shiftPattern: plant.shifts,
      tickMs: 3_600_000,
    });
    await shifts.start();
    return shifts;
  };
  let shifts = await create();
  const scheduled = shiftInstances(plant.shifts, run.start, run.end).filter(
    (s) => s.start < run.end,
  );
  const stored = async () =>
    (
      await db
        .selectFrom('shifts.shift_instance')
        .select(['epoch', 'shift_key', 'start_time', 'end_time', 'breaks'])
        .orderBy('start_time')
        .execute()
    ).map((row) => ({
      epoch: row.epoch,
      key: row.shift_key,
      start: row.start_time.getTime(),
      end: row.end_time.getTime(),
      breaks: row.breaks.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })),
    }));
  const calendar = scheduled.map((s) => ({
    epoch: EPOCH,
    key: s.key,
    start: s.start,
    end: s.end,
    breaks: s.breaks.map((b) => ({ ...b })),
  }));
  expect(await stored()).toEqual(calendar);
  // An MES restart finds them and creates nothing twice.
  await shifts.stop();
  shifts = await create();
  expect(await stored()).toEqual(calendar);

  const truth = run.truth;
  const scopes = alarms.scopes().filter((s) => s.scope !== 'equipment');
  let compared = 0;
  let final = 0;
  for (const s of scheduled) {
    const report = await shifts.report(s.date, s.shift, EPOCH);
    if (!report) throw new Error(`no report ${s.key}`);
    const bucket = { key: s.key, start: s.start, end: s.end };
    // OEE: byte for byte the body of /shifts/{date}/{shift}/oee, and the ground truth.
    expect(JSON.stringify(shiftOeeDto(bucket, report.oee))).toBe(
      JSON.stringify(shiftOeeDto(bucket, await oee.shift(bucket, EPOCH))),
    );
    for (const b of report.oee.equipment) {
      expect([s.key, b.id, resultDto(b.result)]).toEqual([
        s.key,
        b.id,
        truth.oee.machines[b.id]?.shifts[s.key]?.result,
      ]);
    }
    // Production per machine: the OEE inputs and the ground truth's cycles and totals.
    for (const m of report.production.machines) {
      const expected = truth.oee.machines[m.equipment]?.shifts[s.key];
      const count = (result: string) =>
        (expected?.inputs.cycles ?? [])
          .filter((c) => c.result === result)
          .reduce((sum, c) => sum + c.count, 0);
      const totals = (expected?.result as { totals: Record<string, number> } | undefined)?.totals;
      expect([s.key, m.equipment, m.produced, m.good, m.scrap, m.rework]).toEqual([
        s.key,
        m.equipment,
        count('good') + count('scrap') + count('rework'),
        count('good'),
        count('scrap'),
        count('rework'),
      ]);
      expect([m.produced, m.good, m.scrap, m.rework]).toEqual([
        totals?.produced,
        totals?.good,
        totals?.scrap,
        totals?.rework,
      ]);
    }
    expect(report.production.finished).toEqual({
      equipment: 'pck-01',
      good: report.production.machines.find((m) => m.equipment === 'pck-01')?.good ?? 0,
    });
    // The Pareto by reason sums to the own plus external availability loss of the machines.
    const loss = { own: 0, external: 0 };
    for (const b of report.oee.equipment) {
      loss.own += Number(b.result.losses?.availability.own.total ?? 0n);
      loss.external += Number(b.result.losses?.availability.external.total ?? 0n);
    }
    expect([s.key, report.downtime.pareto.availability]).toEqual([s.key, loss]);
    expect(report.downtime.pareto.reasons.reduce((sum, r) => sum + r.ms, 0)).toBe(
      loss.own + loss.external,
    );
    // Downtime records: the summary has no record list, so `records` and `longest` (equipment,
    // start, length, longest first) are checked against the records computed from the event log
    // (`lossRecords`, as `expectRecords` checks the stored ones); `uncodedMs` is 0, since no
    // golden record is UNCODED (asserted there) and nothing is coded.
    const expectedRecords = lossRecords(run)
      .records.filter((r) => r.shiftKey === s.key)
      .map((r) => [r.equipment, r.start, r.end - r.start] as const)
      .sort((a, b) => b[2] - a[2] || a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect([s.key, report.downtime.records, report.downtime.uncodedMs]).toEqual([
      s.key,
      expectedRecords.length,
      0,
    ]);
    const watermark = equipment.watermark(EPOCH)?.getTime() ?? run.end;
    expect([
      s.key,
      report.downtime.longest.map((r) => [
        r.equipment,
        r.start.getTime(),
        (r.end?.getTime() ?? Math.max(r.start.getTime(), watermark)) - r.start.getTime(),
      ]),
    ]).toEqual([s.key, expectedRecords.slice(0, LONGEST_RECORDS)]);
    // Alarms per scope: GET /alarms/kpi for the shift, the ground truth, the top 5 bad actors.
    expect(report.alarms.map((a) => a.scope.id).sort()).toEqual(scopes.map((x) => x.id).sort());
    for (const section of report.alarms) {
      const id = section.scope.id;
      const [kpi] = (
        await alarms.kpis({
          scope: section.scope.scope,
          id,
          bucket: 'shift',
          from: new Date(s.start),
          to: new Date(s.end),
          epoch: EPOCH,
        })
      ).filter((b) => b.key === s.key);
      if (!kpi || !section.kpis) throw new Error(`no alarm KPIs for ${id} ${s.key}`);
      expect(alarmKpiDto(section.kpis)).toEqual(alarmKpiDto(kpi));
      expect([id, s.key, truthShape(section.kpis)]).toEqual([
        id,
        s.key,
        truth.alarms.scopes[id]?.shifts[s.key],
      ]);
      expect([id, s.key, section.badActors.map(badActorDto)]).toEqual([
        id,
        s.key,
        truth.alarms.scopes[id]?.badActors.shifts[s.key]?.slice(0, REPORT_BAD_ACTORS),
      ]);
      compared += 2;
      // The MES-only operator figures (#143) are not reconciled with the ground truth (it knows
      // no operator): they equal GET /alarms/operator-kpi for the shift, and with no operator
      // write every raise is annunciated, none acknowledged and nothing shelved.
      const operator = await alarms.operatorMeasures({
        scope: section.scope.scope,
        id,
        bucket: 'shift',
        from: new Date(s.start),
        to: new Date(s.end),
        epoch: EPOCH,
      });
      expect([id, s.key, section.operator]).toEqual([
        id,
        s.key,
        operator.buckets.find((b) => b.key === s.key) ?? null,
      ]);
      expect([
        id,
        s.key,
        section.operator?.shelvedRaises,
        section.operator?.annunciatedRaises,
        section.operator?.timeToAck.count,
        section.operator?.shelvedMs,
      ]).toEqual([id, s.key, 0, section.kpis.kpis.raises, 0, []]);
    }
    // Final exactly when its inputs are; then no revision (nothing changed, nothing written).
    const inputsFinal =
      [...report.oee.equipment, ...report.oee.workCenters].every((b) => b.final) &&
      report.alarms.every((a) => a.kpis?.final === true) &&
      (
        await equipment.downtimeRecords({
          from: new Date(s.start),
          to: new Date(s.end),
          epoch: EPOCH,
        })
      ).every((r) => r.shiftKey !== s.key || !r.provisional);
    expect([s.key, report.instance.status === 'final']).toEqual([s.key, inputsFinal]);
    expect([s.key, report.instance.revision]).toEqual([
      s.key,
      { inputs: 0, content: 0, contentAtFinal: inputsFinal ? 0 : null },
    ]);
    expect(report.instance.status).not.toBe('running');
    if (inputsFinal) final++;
    compared += 5 + report.production.machines.length;
  }
  await shifts.stop();
  oee.stop();
  return { compared, shifts: scheduled.length, final };
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
    if (event.machineId && DEVICE_FACTS.includes(event.type)) {
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

/** Every stored alarm occurrence without the wall-clock column, in key order. */
const storedOccurrences = (db: Kysely<Database>) =>
  db
    .selectFrom('alarms.alarm_occurrence')
    .select(['equipment', 'epoch', 'seq', 'code', 'severity', 'priority', 'defined', 'source'])
    .select(['raised_at', 'ended_at', 'end_reason', 'end_seq'])
    .orderBy('equipment')
    .orderBy('epoch')
    .orderBy('seq')
    .execute();

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
/**
 * The downtime records of a run computed from its event log alone (ADR-0021's loss table, the
 * micro-stop threshold over the whole interval, one record per scheduled shift bucket, an
 * interval still open at the run's end running to it, the watermark), and how many loss
 * intervals they come from. The ground truth's summary has no record list, so this is what the
 * MES's records and the shift report's downtime section are checked against.
 */
function lossRecords(run: Run): {
  records: { equipment: string; start: number; end: number; shiftKey: string }[];
  lossIntervals: number;
} {
  const segments = shiftSegments(plant.shifts, run.start, run.end);
  const records: { equipment: string; start: number; end: number; shiftKey: string }[] = [];
  const byMachine = new Map<string, { at: number; state: string; cause: string | null }[]>();
  for (const event of run.events) {
    if (event.type !== 'state' || !event.machineId) continue;
    const list = byMachine.get(event.machineId) ?? [{ at: run.start, state: 'Off', cause: null }];
    list.push({ at: Date.parse(event.at), state: event.to ?? 'Idle', cause: event.cause ?? null });
    byMachine.set(event.machineId, list);
  }
  let lossIntervals = 0;
  for (const [machine, points] of byMachine) {
    points.forEach((point, i) => {
      const end = points[i + 1]?.at ?? run.end;
      if (end <= point.at) return;
      // Under `scheduledTime: orders`, Idle NO-ORDER is outside planned busy time (#175).
      if (
        plant.oee.scheduledTime === 'orders' &&
        point.state === 'Idle' &&
        point.cause === 'NO-ORDER'
      ) {
        return;
      }
      if (!availabilityLoss(point.state, end - point.at, plant.oee.microStopThresholdMs)) return;
      // Inside planned time only: the no-shift bucket has none, so nothing is lost there.
      const pieces = segments
        .filter((seg) => seg.key !== NO_SHIFT && seg.to > point.at && seg.from < end)
        .map((seg) => ({
          equipment: machine,
          start: Math.max(point.at, seg.from),
          end: Math.min(end, seg.to),
          shiftKey: seg.key,
        }));
      if (pieces.length > 0) lossIntervals++;
      records.push(...pieces);
    });
  }
  return { records, lossIntervals };
}

async function expectRecords(db: Kysely<Database>, run: Run) {
  const last = lastFacts(run);
  const { records, lossIntervals } = lossRecords(run);
  const expectedKeys = records.map((r) => `${r.equipment} ${new Date(r.start).toISOString()}`);
  const stored = await storedRecords(db);
  expect(stored.map((r) => `${r.equipment} ${r.start_time.toISOString()}`).sort()).toEqual(
    expectedKeys.sort(),
  );
  expect(stored.filter((r) => r.auto_reason === UNCODED)).toEqual([]);
  // Closed and final, but for an interval still open when its machine last reported (alarms-01).
  expect(
    stored.filter(
      (r) =>
        (r.provisional || r.end_time === null) &&
        (r.end_time?.getTime() ?? Infinity) <= (last.get(r.equipment) ?? Infinity),
    ),
  ).toEqual([]);
  return { lossIntervals, records: stored.length };
}

// ---- Orders mode (#175): the orders and execution modules against the order ground truth ----

/** The ERP serving a scenario's dataset (`@shopfloor/contracts/erp-api`), storing every post. */
class GoldenErp implements ErpApi {
  readonly feedId = 'b'.repeat(32);
  readonly posts: { kind: 'status' | 'confirmation'; key: string; body: unknown }[] = [];
  readonly #entries: readonly FeedEntry[];

  constructor(entries: readonly FeedEntry[]) {
    this.#entries = entries;
  }

  feed(after: number, limit: number): Promise<FeedPage> {
    const entries = this.#entries.slice(after, after + limit);
    return Promise.resolve({
      kind: 'page',
      page: {
        feedId: this.feedId,
        entries: [...entries],
        cursor: entries.at(-1)?.feedSeq ?? after,
        more: after + entries.length < this.#entries.length,
      },
    });
  }

  post(kind: 'status' | 'confirmation', key: string, body: unknown): Promise<PostOutcome> {
    const replay = this.posts.find((p) => p.key === key);
    if (replay && JSON.stringify(replay.body) !== JSON.stringify(body)) {
      return Promise.resolve({ kind: 'conflict', status: 409, detail: `${key}: another body` });
    }
    if (!replay) this.posts.push({ kind, key, body });
    return Promise.resolve({
      kind: 'stored',
      status: replay ? 200 : 201,
      receipt: {
        idempotencyKey: key,
        kind,
        orderNumber: key.split('~')[0] ?? '',
        receivedSeq: this.posts.findIndex((p) => p.key === key) + 1,
        receivedAt: new Date(0).toISOString(),
      },
    });
  }
}

/** The broker as the command outbox sees it: records every publish. */
class CommandSink implements CommandPublisher {
  readonly connected = true;
  readonly published: string[] = [];

  publish(topic: string): Promise<void> {
    this.published.push(topic);
    return Promise.resolve();
  }
}

interface ScenarioFile {
  readonly erp: { readonly dataset: string; readonly release: readonly string[] };
  readonly dispatches: readonly {
    readonly commandId: string;
    readonly machine: string;
    readonly orderId: string;
    readonly product: string;
    readonly quantity: number;
    readonly notBefore: string;
  }[];
}

interface OrdersStack {
  readonly orders: Orders;
  readonly execution: Execution;
  readonly erp: GoldenErp;
  readonly scenario: ScenarioFile;
  readonly by: { readonly by: WriteBy; readonly requestId: string };
}

/**
 * The orders and execution modules over a reconciliation's database, with the scenario's ERP
 * dataset behind a fake ERP and a recording command sink in place of the broker. Commands live
 * for an hour (wall time), so a slow replay never declares one failed.
 */
async function ordersStack(
  m: { db: Kysely<Database>; ingest: Ingest; masterData: MasterData; equipment: Equipment },
  dir: string,
  run: Run,
): Promise<OrdersStack> {
  const scenario = JSON.parse(await readFile(join(dir, 'scenario.json'), 'utf8')) as ScenarioFile;
  const dataset: unknown = JSON.parse(await readFile(join(dir, scenario.erp.dataset), 'utf8'));
  const expanded = expandErpDataset(dataset, erpMasterData(plant));
  if (!expanded.ok) throw new Error(expanded.issues.join('\n'));
  const erp = new GoldenErp(expanded.feed);
  const user = await new Identity({
    db: m.db,
    sweepMs: 0,
    hashParams: { N: 1024, r: 8, p: 1 },
  }).createUser(
    {
      username: 'supervisor',
      roles: ['supervisor'],
      password: 'a-long-test-password',
      mustChangePassword: false,
    },
    { system: 'test' },
  );
  const clock = () => m.equipment.watermark(EPOCH) ?? new Date(run.start);
  const orders = new Orders({
    db: m.db,
    ingest: m.ingest,
    masterData: m.masterData,
    publisher: new CommandSink(),
    erp,
    clock,
    tickMs: 0,
    erpPollMs: 0,
    erpPostMs: 0,
    timings: { ttlMs: 3_600_000, failMarginMs: 3_600_000 },
  });
  await orders.start();
  const execution = new Execution({
    db: m.db,
    ingest: m.ingest,
    masterData: m.masterData,
    orders,
    rework: {
      test: plant.process.leakTest.operation,
      back: plant.process.leakTest.reworkOperation,
    },
    clock,
    tickMs: 0,
  });
  await execution.start();
  orders.useBlankCounter(execution);
  return {
    orders,
    execution,
    erp,
    scenario,
    by: {
      by: { userId: user.id, username: 'supervisor', roles: ['supervisor'] },
      requestId: 'golden',
    },
  };
}

/**
 * Plan "Golden": the MES imports every order (none rejected), and dispatching the released orders
 * in planned-start order at the start time reproduces the scenario's `dispatches` exactly (ids,
 * machines, quantities, `notBefore`). Both CNCs' runs are known from their first facts.
 */
async function dispatchScenario(stack: OrdersStack): Promise<void> {
  const { orders, scenario, by } = stack;
  await orders.importNow();
  const all = (await orders.list()).orders;
  expect(all.filter((o) => o.status === 'rejected')).toEqual([]);
  for (const id of scenario.erp.release) {
    const found = all.find((o) => o.id === id);
    await orders.release(id, { version: found?.version ?? 0 }, by);
  }
  for (const order of (await orders.list({ status: ['released'] })).orders) {
    await orders.dispatch(order.id, { version: order.version }, by);
  }
  expect(
    (await orders.commands()).map((c) => ({
      commandId: c.commandId,
      machine: c.equipment,
      orderId: c.orderId,
      product: c.product,
      quantity: c.quantity,
      notBefore: c.notBefore.toISOString(),
    })),
  ).toEqual(scenario.dispatches);
}

/** A run's facts before its first job fact (the machines' first states) and from it on. */
function splitAtFirstJob(facts: readonly Delivery[]): {
  before: Delivery[];
  after: Delivery[];
} {
  const at = facts.findIndex((d) => d.topic.endsWith('/events/job'));
  return at < 0
    ? { before: [...facts], after: [] }
    : { before: facts.slice(0, at), after: facts.slice(at) };
}

/** Brings commands, units, completion and confirmations up to date, then posts the ERP outbox. */
async function settleOrders(stack: OrdersStack): Promise<void> {
  for (let round = 0; round < 2; round++) {
    await stack.orders.tick();
    await stack.execution.tick();
  }
  while ((await stack.orders.postNow()) > 0) {
    // Posts the outbox in batches until nothing is pending.
  }
}

/** A unit as the ground truth hashes it (`unitsDocument`, sim-summary/4). */
interface TruthUnit {
  readonly partId: number;
  readonly serial: string;
  readonly orderId: string;
  readonly records: readonly {
    readonly operation: string;
    readonly equipment: string;
    readonly pass: number;
    readonly at: string;
    readonly result: string;
    readonly reason?: string;
  }[];
}

/** Canonical JSON, keys sorted (the simulator's `stableStringify`; apps never import each other). */
function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

/**
 * Every unit with its operation records, derived from the event log alone (plan "Golden": the full
 * list, as the ground truth hashes it): a part belongs to the job whose `started` event is the
 * latest on its CNC before its blank was taken; passes follow leak-test reworks. Also each unit's
 * expected WIP position (`after:OPxx`, `rework:OPxx`, or `at:{machine}` when its machine ends
 * Blocked holding it), and whether a CNC still holds its blank with no cycle yet.
 */
function eventLogUnits(run: Run): {
  units: TruthUnit[];
  positions: Map<number, string>;
} {
  const operationOf = new Map<string, string>();
  for (const area of plant.plant.areas) {
    for (const wc of area.workCenters) {
      for (const item of wc.equipment) operationOf.set(item.id, item.operation);
    }
  }
  const first = plant.products.operations[0] ?? 'OP10';
  const last = plant.products.operations.at(-1) ?? 'OP50';
  const reworkOps = new Set([
    plant.process.leakTest.operation,
    plant.process.leakTest.reworkOperation,
  ]);
  const current = new Map<string, string>();
  const jobs = new Map<string, string>();
  const units = new Map<
    number,
    { serial: string; orderId: string; records: TruthUnit['records'][number][]; reworks: number }
  >();
  const lastCycle = new Map<string, number>();
  const lastState = new Map<string, string>();
  const unitOf = (machine: string, partId: number) => {
    const known = units.get(partId);
    if (known) return known;
    if (operationOf.get(machine) !== first) return undefined;
    const orderId = jobs.get(current.get(machine) ?? '');
    if (orderId === undefined) return undefined;
    const unit = { serial: '', orderId, records: [], reworks: 0 };
    units.set(partId, unit);
    return unit;
  };
  for (const event of run.events) {
    const machine = event.machineId ?? '';
    if (event.type === 'job') {
      if (event.transition === 'accepted') jobs.set(event.commandId ?? '', event.orderId ?? '');
      if (event.transition === 'started') current.set(machine, event.commandId ?? '');
    } else if (event.type === 'state') {
      lastState.set(machine, event.to ?? '');
    } else if (event.type === 'material-consumed') {
      unitOf(machine, event.partId ?? 0);
    } else if (event.type === 'cycle-complete') {
      lastCycle.set(machine, event.partId ?? 0);
      const unit = unitOf(machine, event.partId ?? 0);
      if (!unit) continue;
      const operation = operationOf.get(machine) ?? '';
      if (event.serial !== undefined && event.serial !== '') unit.serial = event.serial;
      unit.records.push({
        operation,
        equipment: machine,
        pass: reworkOps.has(operation) ? unit.reworks + 1 : 1,
        at: new Date(Date.parse(event.at)).toISOString(),
        result: event.result ?? 'good',
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      });
      if (event.result === 'rework') unit.reworks++;
    }
  }
  const positions = new Map<number, string>();
  for (const [partId, unit] of units) {
    const record = unit.records.at(-1);
    if (!record) continue;
    const terminal =
      record.result === 'scrap' || (record.result === 'good' && record.operation === last);
    if (terminal) continue;
    if (record.result === 'rework') {
      positions.set(partId, `rework:${plant.process.leakTest.reworkOperation}`);
    } else if (
      lastState.get(record.equipment) === 'Blocked' &&
      lastCycle.get(record.equipment) === partId
    ) {
      positions.set(partId, `at:${record.equipment}`);
    } else {
      positions.set(partId, `after:${record.operation}`);
    }
  }
  return {
    units: [...units]
      .sort(([a], [b]) => a - b)
      .map(([partId, unit]) => ({
        partId,
        serial: unit.serial,
        orderId: unit.orderId,
        records: unit.records,
      })),
    positions,
  };
}

/**
 * Plan "Golden" and exit criterion 2 (#175): every command is confirmed by exactly one `accepted`
 * fact, with no command, job or routing incident; every unit's operation records equal the ground
 * truth's (the event log's list, whose hash is `units.sha256`); per order and operation the
 * quantities, scrap by reason, rework passes, backflushed material (booked at cycle completion;
 * material in process not compared), packed good, completion time and WIP equal the ground truth;
 * the confirmations equal those computed from it, none a correction; completed orders are
 * `completed` (`short` when packed good < quantity). Returns the comparison counts.
 */
async function expectOrders(
  stack: OrdersStack,
  ingest: Ingest,
  run: Run,
): Promise<{ units: number; confirmations: number; orders: number }> {
  const truth = run.truth.orders;
  const { orders, execution, erp } = stack;
  // Commands: one accepted fact each, all confirmed; no incident of either module.
  const commands = await orders.commands();
  expect(commands.map((c) => c.commandId).sort()).toEqual(
    truth.jobs.map((j) => j.commandId).sort(),
  );
  for (const command of commands) {
    const accepted = (await ingest.jobFacts({ commandIds: [command.commandId] })).filter(
      (f) => f.transition === 'accepted',
    );
    expect([command.commandId, accepted.length, command.state, command.confirmed]).toEqual([
      command.commandId,
      1,
      'accepted',
      true,
    ]);
  }
  expect(await orders.incidents()).toEqual([]);
  expect(await execution.incidents()).toEqual([]);

  // Units: the event log's list hashes to the ground truth's; the MES's equals it but for blanks
  // still in a CNC (no cycle fact yet), which it counts per order instead.
  const derived = eventLogUnits(run);
  expect(derived.units).toHaveLength(truth.units.count);
  expect(createHash('sha256').update(canonicalJson(derived.units)).digest('hex')).toBe(
    truth.units.sha256,
  );
  const seen = derived.units.filter((u) => u.records.length > 0);
  const stored = (await execution.units({ epoch: EPOCH, limit: 100_000 })).units;
  expect(
    stored.map((u) => ({
      partId: u.partId,
      serial: u.serial ?? '',
      orderId: u.orderId,
      records: u.records.map((r) => ({
        operation: r.operation,
        equipment: r.equipment,
        pass: r.pass,
        at: r.at.toISOString(),
        result: r.result,
        ...(r.reason === null ? {} : { reason: r.reason }),
      })),
    })),
  ).toEqual(seen);
  const blanks = new Map<string, number>();
  for (const unit of derived.units.filter((u) => u.records.length === 0)) {
    blanks.set(unit.orderId, (blanks.get(unit.orderId) ?? 0) + 1);
  }

  // Per order: quantities, scrap, rework, material, packed, completion, WIP; and its status.
  let confirmations = 0;
  for (const [id, order] of Object.entries(truth.orders)) {
    const mes = await execution.orderExecution(id);
    if (!mes) throw new Error(`no order ${id}`);
    const operations = Object.fromEntries(
      mes.operations
        .filter((op) => op.in > 0)
        .map((op) => [
          op.operation,
          {
            in: op.in,
            good: op.good,
            scrap: Object.values(op.scrap).reduce((sum, n) => sum + n, 0),
            rework: op.rework,
          },
        ]),
    );
    const material: Record<string, number> = {};
    for (const op of mes.operations) {
      for (const [item, n] of Object.entries(op.material))
        material[item] = (material[item] ?? 0) + n;
    }
    const wipTotal = mes.units.wip + Object.values(mes.inMachine).reduce((s, n) => s + n, 0);
    expect({
      id,
      operations,
      scrap: mes.scrap,
      reworkPasses: mes.reworkPasses,
      packedGood: mes.packedGood,
      material: Object.fromEntries(Object.entries(material).sort(([a], [b]) => (a < b ? -1 : 1))),
      completedAt: mes.completedAt?.toISOString() ?? null,
      wip: wipTotal,
      started: mes.units.total + Object.values(mes.inMachine).reduce((s, n) => s + n, 0),
      inMachine: Object.values(mes.inMachine).reduce((s, n) => s + n, 0),
    }).toEqual({
      id,
      operations: order.operations,
      scrap: order.scrap,
      reworkPasses: order.reworkPasses,
      packedGood: order.packedGood,
      material: order.material,
      completedAt: order.completedAt,
      wip: Object.values(order.wip).reduce((s, n) => s + n, 0),
      started: order.started,
      inMachine: blanks.get(id) ?? 0,
    });
    // A CNC's place in the ground truth's WIP is a blank in it, or the part it holds Blocked.
    for (const [cnc, n] of Object.entries(mes.inMachine)) {
      expect([id, cnc, n + (mes.wip[`at:${cnc}`] ?? 0)]).toEqual([id, cnc, order.wip[cnc]]);
    }
    // Positions in WIP: as the event log places each unit.
    const expected: Record<string, number> = {};
    for (const unit of seen.filter((u) => u.orderId === id)) {
      const position = derived.positions.get(unit.partId);
      if (position !== undefined) expected[position] = (expected[position] ?? 0) + 1;
    }
    expect([id, mes.wip]).toEqual([
      id,
      Object.fromEntries(Object.entries(expected).sort(([a], [b]) => (a < b ? -1 : 1))),
    ]);
    // Status and confirmations: computed from the ground truth for a complete order, none else.
    const record = await orders.order(id);
    const sent = await orders.confirmations(id);
    if (order.completedAt === null) {
      expect([id, record?.status, sent]).toEqual([id, 'in-progress', []]);
      continue;
    }
    expect([id, record?.status, record?.short]).toEqual([
      id,
      'completed',
      order.packedGood < (record?.quantity ?? 0),
    ]);
    const bom = record?.bom ?? [];
    const want = plant.products.operations.map((operation) => {
      const materials = new Set(
        bom.filter((b) => b.operation === operation).map((b) => b.material),
      );
      return {
        key: confirmationKey(id, operation, 1),
        kind: 'final',
        yield: order.operations[operation]?.good ?? 0,
        scrap: order.scrap[operation] ?? {},
        reworkPasses: order.operations[operation]?.rework ?? 0,
        material: Object.fromEntries(
          Object.entries(order.material).filter(([item]) => materials.has(item)),
        ),
        messageStatus: 'sent',
      };
    });
    expect([
      id,
      sent.map((c) => ({
        key: c.idempotencyKey,
        kind: c.kind,
        yield: c.yield,
        scrap: c.scrap,
        reworkPasses: c.reworkPasses,
        material: c.material,
        messageStatus: c.messageStatus,
      })),
    ]).toEqual([id, want]);
    confirmations += sent.length;
  }
  // What the ERP received: exactly these confirmations, none a correction.
  const posted = erp.posts.filter((p) => p.kind === 'confirmation');
  expect(posted).toHaveLength(confirmations);
  expect(posted.filter((p) => (p.body as { kind: string }).kind !== 'final')).toEqual([]);
  return { units: stored.length, confirmations, orders: Object.keys(truth.orders).length };
}

/** Rows of the execution and confirmation tables without wall-clock columns, in key order. */
async function storedExecution(db: Kysely<Database>) {
  return {
    units: await db
      .selectFrom('execution.unit')
      .select(['epoch', 'part_id', 'serial', 'order_id', 'command_id', 'status', 'position'])
      .select(['last_at', 'terminal_at', 'suspect', 'violation'])
      .orderBy('epoch')
      .orderBy('part_id')
      .execute(),
    records: await db
      .selectFrom('execution.operation_record')
      .selectAll()
      .orderBy('equipment')
      .orderBy('epoch')
      .orderBy('seq')
      .execute(),
    scrap: await db
      .selectFrom('execution.scrap_record')
      .select(['equipment', 'epoch', 'seq', 'part_id', 'order_id', 'operation', 'pass'])
      .select(['scrapped_at', 'machine_reason', 'version'])
      .orderBy('equipment')
      .orderBy('seq')
      .execute(),
    confirmations: await db
      .selectFrom('orders.confirmation')
      .select(['order_id', 'operation', 'n', 'kind', 'yield', 'scrap', 'rework_passes'])
      .select(['material', 'confirmed_at', 'idempotency_key'])
      .orderBy('order_id')
      .orderBy('operation')
      .orderBy('n')
      .execute(),
  };
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
  /** Run as this golden scenario by name (`--scenario`, with its injections). */
  readonly scenario?: string;
  /** OEE buckets the ground truth has (machines and work centers × shift buckets), if pinned. */
  readonly oeeBuckets?: number;
  /** Alarm comparisons (occurrences, KPI buckets, floods and bad actors), if pinned. */
  readonly alarmComparisons?: number;
  /** Whether every machine reports at the run's end (the golden week ends with a shutdown). */
  readonly settledToEnd?: boolean;
  /** Shift instances of the run and the shift reports final (#144), if pinned. */
  readonly shifts?: {
    readonly instances: number;
    readonly final: number;
    readonly compared: number;
  };
  /**
   * Orders mode (#175): the scenario's ERP dataset and dispatches go through the orders and
   * execution modules, reconciled per order, operation and unit; the pinned comparison counts.
   */
  readonly orders?: OrdersPins;
}

/** What an orders-mode reconciliation compares, pinned (#175). */
export interface OrdersPins {
  /** Units with operation records (the ground truth's units minus blanks still in a CNC). */
  readonly units: number;
  /** Final confirmations (orders complete × operations). */
  readonly confirmations: number;
  /** Orders the ground truth has, each compared by operation. */
  readonly orders: number;
}

/** A golden scenario of apps/simulator/golden by name. */
export async function golden(
  name: string,
  pinned: Pick<
    Scenario,
    'oeeBuckets' | 'alarmComparisons' | 'settledToEnd' | 'shifts' | 'orders'
  > = {},
): Promise<Scenario> {
  const dir = join(GOLDENS, name);
  const scenario = JSON.parse(await readFile(join(dir, 'scenario.json'), 'utf8')) as Scenario;
  return {
    seed: scenario.seed,
    start: scenario.start,
    days: scenario.days,
    golden: dir,
    scenario: name,
    ...pinned,
  };
}

/** The golden week's scenario (apps/simulator/golden/week-01). */
export async function goldenWeek(): Promise<Scenario> {
  const scenario = JSON.parse(await readFile(join(GOLDEN, 'scenario.json'), 'utf8')) as Scenario;
  return {
    seed: scenario.seed,
    start: scenario.start,
    days: scenario.days,
    golden: GOLDEN,
    oeeBuckets: 128,
    // 2 occurrences; plant and both positions: their hours, 16 shift buckets, floods, run and
    // shift bad actors.
    alarmComparisons: 112,
    settledToEnd: true,
    // 15 shift reports (#144), all final but Friday's shift C: every machine shuts down exactly at
    // its end, so its alarm KPI buckets (end + fleetingMs) stay provisional.
    shifts: { instances: 15, final: 14, compared: 255 },
  };
}

/**
 * Both reconciliation tests for one simulated span: in-order delivery equals the ground truth
 * per machine and shift bucket to the millisecond, with every piece inside one hour and one shift;
 * shuffled delivery with duplicates stores the very same intervals.
 */
export function reconciliationSuite(title: string, scenario: () => Promise<Scenario>): void {
  describe(title, () => {
    let run: Run;
    let span: Scenario;
    let reference: Kysely<Database>;
    /** Every shift report of the run against the ground truth (#144), with the pinned counts. */
    const checkReports = async (
      label: string,
      m: Pick<
        Awaited<ReturnType<typeof mes>>,
        'db' | 'equipment' | 'ingest' | 'masterData' | 'alarms'
      >,
    ) => {
      const reports = await expectShiftReports(
        m.db,
        m.equipment,
        m.ingest,
        m.masterData,
        m.alarms,
        run,
      );
      if (span.shifts !== undefined) {
        expect([reports.shifts, reports.final, reports.compared]).toEqual([
          span.shifts.instances,
          span.shifts.final,
          span.shifts.compared,
        ]);
      }
      console.log(
        `${title}: ${label}, ${String(reports.shifts)} shift reports (${String(reports.final)} final) reconciled in ${String(reports.compared)} comparisons`,
      );
    };

    it(
      'in order: time per state, per machine and shift, equals the ground truth to the ms',
      async () => {
        span = await scenario();
        run = await headless(span);
        if (span.golden) {
          // The very run the golden snapshot pins.
          expect(run.summaryText).toBe(await readFile(join(span.golden, 'summary.json'), 'utf8'));
        }
        const { facts, anchors, end } = unsMessages(run);
        const { db, equipment, ingest, masterData, alarms, send } = await mes();
        reference = db;
        let stack: OrdersStack | undefined;
        if (span.orders !== undefined && span.golden !== undefined) {
          // Orders mode (#175, B3): the machines' first facts, then the MES dispatches the released
          // orders while the CNCs are idle at the start time, then the rest of the run.
          const { before, after } = splitAtFirstJob(facts);
          await send([...anchors, ...before]);
          stack = await ordersStack({ db, ingest, masterData, equipment }, span.golden, run);
          await dispatchScenario(stack);
          await send([...after, end]);
        } else {
          await send([...anchors, ...facts, end]);
        }
        await alarms.flush();
        expect(equipment.watermark(EPOCH)).toEqual(new Date(run.end));
        expect(await totals(equipment, db)).toEqual(expected(run.truth));
        expect(await expectInsideBuckets(db, run)).toBeGreaterThan(facts.length / 2);
        // Every machine shuts down at the end of the last shift (a state fact at its very end):
        // only the weekend's no-shift bucket, after its last fact, is still provisional.
        const provisional = await expectFinality(equipment, db, run);
        expect(provisional.length).toBeGreaterThan(0);
        if (span.settledToEnd === true) {
          expect(provisional.filter((bucket) => !bucket.includes(' no-shift '))).toEqual([]);
        }
        expect(await expectAggregates(equipment, ingest, db, run)).toBe(6);
        const compared = await expectOee(equipment, ingest, masterData, run);
        // week-01: 6 machines and 2 work centers × 16 buckets.
        if (span.oeeBuckets !== undefined) expect(compared).toBe(span.oeeBuckets);
        console.log(`${title}: in order, ${String(compared)} OEE buckets equal the ground truth`);
        const downtime = await expectRecords(db, run);
        expect(downtime.records).toBeGreaterThanOrEqual(downtime.lossIntervals);
        expect(downtime.lossIntervals).toBeGreaterThan(0);
        const alarmed = await expectAlarms(alarms, run);
        if (span.alarmComparisons !== undefined) {
          expect(alarmed.compared).toBe(span.alarmComparisons);
        }
        expect(alarmed.final).toBeGreaterThan(0);
        console.log(
          `${title}: in order, ${String(alarmed.compared)} alarm comparisons equal the ground truth; ${String(alarmed.final)} KPI buckets final, not final (no fact after them): ${alarmed.open.join(', ') || 'none'}`,
        );
        await checkReports('in order', { db, equipment, ingest, masterData, alarms });
        const traced = await expectCycleLots(ingest, run);
        expect(traced.lots).toBeGreaterThan(0);
        expect(traced.tracedCycles).toBeGreaterThan(0);
        console.log(
          `${title}: in order, lots and operator of every cycle equal the event log's (${String(traced.tracedCycles)} cycles with ${String(traced.lots)} lots, ${String(traced.operatorCycles)} with an operator, ${String(traced.operatorChanged)} whose operator changed before the cycle ended)`,
        );
        if (stack && span.orders) {
          await settleOrders(stack);
          const counts = await expectOrders(stack, ingest, run);
          expect(counts).toEqual(span.orders);
          console.log(
            `${title}: in order, ${String(counts.units)} units, ${String(counts.orders)} orders and ${String(counts.confirmations)} confirmations equal the ground truth`,
          );
          await stack.execution.stop();
          await stack.orders.stop();
        }
        await alarms.stop();
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
        const { db, equipment, ingest, masterData, alarms, send } = await mes();
        let stack: OrdersStack | undefined;
        if (span.orders !== undefined && span.golden !== undefined) {
          // Orders mode (#175): dispatched at the idle start as in order, then the rest shuffled
          // with 10 % duplicates, units, completion and confirmations brought up to date every 400
          // deliveries, so they are judged on partial, reordered data all along (a confirmation
          // read too early would show as a correction).
          const { before, after } = splitAtFirstJob(facts);
          await send([...anchors, ...before]);
          stack = await ordersStack({ db, ingest, masterData, equipment }, span.golden, run);
          await dispatchScenario(stack);
          const copies = after.filter(() => next() < 0.1);
          const mixed = shuffle([...after, ...copies], next);
          for (let i = 0; i < mixed.length; i += 400) {
            await send(mixed.slice(i, i + 400));
            await stack.orders.tick();
            await stack.execution.tick();
            await stack.orders.postNow();
          }
          await send([end, ...mixed.slice(0, 500)]);
        } else {
          const copies = facts.filter(() => next() < 0.1);
          const mixed = shuffle([...anchors, ...facts, ...copies], next);
          // Telemetry flows all along; the last sample, after every fact, ends the observation.
          await send([...mixed, end, ...mixed.slice(0, 500)]);
        }
        await equipment.flush();
        await alarms.flush();
        expect(await storedPieces(db)).toEqual(await storedPieces(reference));
        expect(await storedRecords(db)).toEqual(await storedRecords(reference));
        expect(await totals(equipment, db)).toEqual(expected(run.truth));
        await expectFinality(equipment, db, run);
        // Refreshed in the background all along, while late facts kept changing earlier hours.
        expect(equipment.stateAggregate()?.refreshes).toBeGreaterThan(0);
        expect(await expectAggregates(equipment, ingest, db, run)).toBe(6);
        const compared = await expectOee(equipment, ingest, masterData, run);
        expect(compared).toBeGreaterThan(0);
        console.log(`${title}: shuffled, ${String(compared)} OEE buckets equal the ground truth`);
        expect(await storedOccurrences(db)).toEqual(await storedOccurrences(reference));
        const alarmed = await expectAlarms(alarms, run);
        if (span.alarmComparisons !== undefined) {
          expect(alarmed.compared).toBe(span.alarmComparisons);
        }
        console.log(
          `${title}: shuffled, ${String(alarmed.compared)} alarm comparisons equal the ground truth`,
        );
        await checkReports('shuffled', { db, equipment, ingest, masterData, alarms });
        await expectCycleLots(ingest, run);
        if (stack && span.orders) {
          await settleOrders(stack);
          expect(await expectOrders(stack, ingest, run)).toEqual(span.orders);
          // The very units, records, scrap records and confirmations as delivered in order.
          expect(await storedExecution(db)).toEqual(await storedExecution(reference));
          console.log(
            `${title}: shuffled, units, records and confirmations equal the in-order run`,
          );
          await stack.execution.stop();
          await stack.orders.stop();
        }
        await alarms.stop();
        await equipment.stop();
        await ingest.stop();
        if (span.orders !== undefined && span.golden !== undefined) {
          // More orderings, judged on finer steps (#175 review): other seeds, units, completion
          // and confirmations brought up to date every 97 deliveries.
          for (const seed of [175, 31_415]) {
            const m = await mes();
            const { before, after } = splitAtFirstJob(facts);
            await m.send([...anchors, ...before]);
            const again = await ordersStack(m, span.golden, run);
            await dispatchScenario(again);
            const shuffled = random(seed);
            const mixed = shuffle([...after, ...after.filter(() => shuffled() < 0.1)], shuffled);
            for (let i = 0; i < mixed.length; i += 97) {
              await m.send(mixed.slice(i, i + 97));
              await again.orders.tick();
              await again.execution.tick();
              await again.orders.postNow();
            }
            await m.send([end]);
            await m.equipment.flush();
            await settleOrders(again);
            expect(await expectOrders(again, m.ingest, run)).toEqual(span.orders);
            expect(await storedExecution(m.db)).toEqual(await storedExecution(reference));
            console.log(`${title}: shuffled with seed ${String(seed)}, equal the in-order run`);
            await again.execution.stop();
            await again.orders.stop();
            await m.alarms.stop();
            await m.equipment.stop();
            await m.ingest.stop();
          }
        }
      },
      SHUFFLED_MS,
    );
  });
}
