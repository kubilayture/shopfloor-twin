import { idealCycleMs, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { startDatabase } from './testing.ts';
import { Equipment, downtimeRules } from './modules/equipment/index.ts';
import {
  PLANT_CONFIG,
  UnsFeed,
  freshDatabase,
  type Delivery,
} from './modules/equipment/test-support.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData } from './modules/master-data/index.ts';
import {
  DowntimeFeed,
  Oee,
  downtimeId,
  pareto,
  shiftInstance,
  type DowntimeChange,
  type OeeBucket,
  type OeeChange,
} from './modules/oee/index.ts';

const E1 = 1_760_000_000;
const MINUTE = 60_000;
/** Refreshes run only when a test asks (`refreshAggregates`). */
const MANUAL = { debounceMs: 600_000 };

/** Monday 2026-10-12 at a UTC time; shift A runs 03:00–11:00 UTC (06:00–14:00 Istanbul). */
const at = (time: string): number => Date.parse(`2026-10-12T${time}:00.000Z`);
const date = (time: string): Date => new Date(at(time));
const feed = new UnsFeed(new Map());

let container: StartedTestContainer;
let plant: PlantConfig;
let db: Kysely<Database>;
let ingest: Ingest;
let equipment: Equipment;
let masterData: MasterData;
let oee: Oee;
const seqs = new Map<string, number>();

const next = (machine: string): number => {
  const seq = (seqs.get(machine) ?? 0) + 1;
  seqs.set(machine, seq);
  return seq;
};
const state = (
  machine: string,
  time: string,
  value: Parameters<UnsFeed['state']>[4],
  cause?: string,
) => feed.state(machine, E1, next(machine), at(time), value, cause ?? null);
const cycle = (machine: string, time: string, result: 'good' | 'scrap' | 'rework' = 'good') => {
  const seq = next(machine);
  return feed.cycle(machine, E1, seq, at(time), {
    product: 'VB-100',
    partId: seq,
    serial: `S-${String(seq)}`,
    result,
  });
};
const send = async (...deliveries: Delivery[]): Promise<void> => {
  for (const d of deliveries) await ingest.deliver(d.topic, d.payload);
};
const refresh = async (): Promise<void> => {
  await equipment.refreshAggregates();
  await ingest.refreshAggregates();
};

beforeAll(async () => {
  let url: string;
  ({ url, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
  db = await freshDatabase(url, 'oee');
  masterData = new MasterData(db);
  await masterData.seed(plant);
  ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'unused',
    refresh: MANUAL,
  });
  equipment = new Equipment({
    db,
    source: ingest,
    shiftPattern: await masterData.shiftPattern(),
    provisionalStepMs: 0,
    refresh: MANUAL,
    downtime: downtimeRules(plant),
  });
  await equipment.start();
  await equipment.refreshAggregates();
  oee = new Oee({
    equipment,
    ingest,
    masterData,
    shiftPattern: await masterData.shiftPattern(),
    config: plant.oee,
    idealCycleMs: idealCycleMs(plant),
  });
  await oee.start();
}, 180_000);

afterAll(async () => {
  oee.stop();
  await equipment.stop();
  await ingest.stop();
  await db.destroy();
  await container.stop();
});

const ratios = (bucket: OeeBucket | undefined) => {
  const r = bucket?.result;
  const show = (f: { num: bigint; den: bigint } | null | undefined) =>
    f ? `${String(f.num)}/${String(f.den)}` : null;
  return {
    A: show(r?.availability),
    P: show(r?.performance),
    Q: show(r?.quality),
    OEE: show(r?.oee),
  };
};

describe('OEE on read (#120)', () => {
  beforeAll(async () => {
    // CNC-01, shift A: a micro-stop (1 min), a 20-min stop across 04:00, a breakdown, the break.
    await send(
      state('cnc-01', '03:00', 'Running'),
      cycle('cnc-01', '03:10'),
      cycle('cnc-01', '03:20'),
      cycle('cnc-01', '03:30', 'scrap'),
      state('cnc-01', '03:40', 'Stopped', 'jam'),
      state('cnc-01', '03:41', 'Running'),
      state('cnc-01', '03:50', 'Stopped', 'jam'),
      state('cnc-01', '04:10', 'Running'),
      state('cnc-01', '04:30', 'Down', 'SPINDLE-OVERLOAD'),
      state('cnc-01', '04:40', 'Running'),
      state('cnc-01', '07:00', 'PlannedStop', 'BREAK'),
      state('cnc-01', '07:30', 'Running'),
      state('cnc-01', '11:00', 'Off', 'SHIFT-END'),
      state('cnc-01', '11:30', 'Idle'),
    );
    // The rest of Cell M1 runs through the shift; the washer and CNC-02 report after its end.
    for (const machine of ['cnc-02', 'wsh-01']) {
      await send(
        state(machine, '03:00', 'Running'),
        state(machine, '11:00', 'Off', 'SHIFT-END'),
        state(machine, '11:30', 'Idle'),
      );
    }
    await refresh();
  });

  it('computes hour buckets with exact fractions, losses and finality', async () => {
    const buckets = await oee.buckets({
      scope: 'equipment',
      id: 'cnc-01',
      bucket: 'hour',
      from: date('03:00'),
      to: date('05:00'),
    });
    expect(buckets.map((b) => [b.key, b.shiftKey, b.final, b.provisionalMs])).toEqual([
      ['2026-10-12T03:00:00.000Z', '2026-10-12/A', true, 0],
      ['2026-10-12T04:00:00.000Z', '2026-10-12/A', true, 0],
    ]);
    const [h3, h4] = buckets;
    // 03:00: Running 49 min, Stopped 11 min (1 micro, 10 of the 20-min stop); 3 cycles of 240 s.
    expect(h3?.stateMs).toMatchObject({ Running: 49 * MINUTE, Stopped: 11 * MINUTE });
    expect(h3?.cycles).toEqual([
      { product: 'VB-100', result: 'good', count: 2 },
      { product: 'VB-100', result: 'scrap', count: 1 },
    ]);
    expect(h3?.stops).toBe(2);
    expect(ratios(h3)).toEqual({ A: '5/6', P: '6/25', Q: '2/3', OEE: '2/15' });
    expect(h3?.result.losses?.availability.own.stopped).toBe(BigInt(10 * MINUTE));
    expect(h3?.result.losses?.performance.microStops).toBe(BigInt(MINUTE));
    // 04:00: nothing produced in planned time: Q null, OEE 0.
    expect(ratios(h4)).toEqual({ A: '2/3', P: '0/1', Q: null, OEE: '0/1' });
    expect(h4?.result.losses?.availability.own.down).toBe(BigInt(10 * MINUTE));
    expect(h3?.members).toEqual([{ equipment: 'cnc-01', epoch: E1 }]);
  });

  it('sums hours into the shift and machines into the work center', async () => {
    const instance = shiftInstance(oee.shiftPattern, '2026-10-12', 'A');
    expect(instance).toMatchObject({ key: '2026-10-12/A', start: at('03:00'), end: at('11:00') });
    expect(instance?.breaks).toEqual([{ start: at('07:00'), end: at('07:30') }]);
    const [shift] = await oee.buckets({
      scope: 'equipment',
      id: 'cnc-01',
      bucket: 'shift',
      from: date('04:00'),
      to: date('05:00'),
    });
    expect(shift).toMatchObject({ key: '2026-10-12/A', final: true, revision: 0, incidents: 0 });
    expect(shift?.start).toEqual(date('03:00'));
    expect(shift?.end).toEqual(date('11:00'));
    // PBT 450 min (the break excluded), APT 420 (Running 419 + the 1-min micro-stop).
    expect(shift?.result.totals.plannedBusyMs).toBe(BigInt(450 * MINUTE));
    expect(shift?.result.totals.actualProductionMs).toBe(BigInt(420 * MINUTE));
    expect(ratios(shift).A).toBe('14/15');
    expect(shift?.result.losses?.availability.own.total).toBe(BigInt(30 * MINUTE));

    const all = await oee.shift(instance ?? { key: '', start: 0, end: 0 });
    expect(all.equipment.map((b) => b.id)).toEqual(['cnc-01', 'cnc-02', 'wsh-01']);
    expect(all.equipment[0]?.result).toEqual(shift?.result);
    const cell = all.workCenters.find((b) => b.id === 'cell-m1');
    expect(cell?.members.map((m) => m.equipment)).toEqual(['cnc-01', 'cnc-02', 'wsh-01']);
    expect(cell?.final).toBe(true);
    // ΣPBT = 450 + 480 + 480; ΣAPT = 420 + 480 + 480.
    expect(ratios(cell).A).toBe('46/47');
    // Line A1 has no data: not reported.
    expect(all.workCenters.map((b) => b.id)).toEqual(['cell-m1']);
  });

  it('reads the newest epoch by default and an older one on request', async () => {
    const query = {
      scope: 'equipment' as const,
      id: 'cnc-01',
      bucket: 'hour' as const,
      from: date('03:00'),
      to: date('04:00'),
    };
    const newest = await oee.buckets(query);
    expect(await oee.buckets({ ...query, epoch: E1 })).toEqual(newest);
    expect(await oee.buckets({ ...query, epoch: E1 + 1 })).toEqual([]);
    await expect(oee.buckets({ ...query, id: 'nope' })).rejects.toThrow(/no equipment nope/);
  });

  it('builds the Pareto from the records and the micro-stops, equal to the OEE losses', async () => {
    const read = await oee.paretoInputs(
      'equipment',
      'cnc-01',
      date('03:00'),
      date('11:00'),
      undefined,
    );
    const result = pareto({
      ...read,
      from: date('03:00'),
      to: date('11:00'),
      thresholdMs: plant.oee.microStopThresholdMs,
      reasons: await oee.reasonCodes(),
    });
    expect(result.availability).toEqual({ own: 30 * MINUTE, external: 0 });
    expect(result.reasons.map((r) => [r.reason, r.loss, r.ms, r.records])).toEqual([
      ['UNCODED', 'own', 20 * MINUTE, 1],
      ['BREAKDOWN/SPINDLE-OVERLOAD', 'own', 10 * MINUTE, 1],
    ]);
    expect(result.microStops).toEqual([{ cause: 'jam', ms: MINUTE, stops: 1 }]);
    expect(read.members).toEqual([{ equipment: 'cnc-01', epoch: E1 }]);
    const [first] = await equipment.downtimeRecords({
      from: date('03:00'),
      to: date('11:00'),
      equipment: 'cnc-01',
    });
    expect(downtimeId(first ?? { equipment: '', epoch: 0, start: new Date(0) })).toBe(
      `cnc-01~${String(E1)}~${String(at('03:50'))}`,
    );
    // The work center sums its machines (CNC-02 and the washer ran without a loss).
    const cell = await oee.paretoInputs(
      'work-center',
      'cell-m1',
      date('03:00'),
      date('11:00'),
      undefined,
    );
    expect(cell.members.map((m) => m.equipment)).toEqual(['cnc-01']);
    expect(cell.losses.reduce((sum, l) => sum + l.ms, 0)).toBe(30 * MINUTE);
  });

  it('keeps an open stop provisional and reports changes and downtime records as they happen', async () => {
    const changes: OeeChange[] = [];
    const stopListening = oee.onChange((change) => changes.push(change));
    const feedOfRecords = new DowntimeFeed({ equipment, debounceMs: 10 });
    const events: DowntimeChange[] = [];
    feedOfRecords.subscribe((change) => events.push(change));
    await feedOfRecords.settle();

    // CNC-02 stops at 12:00 (shift B); the plant clock moves to 12:01.
    await send(
      state('cnc-02', '12:00', 'Stopped', 'jam'),
      feed.telemetry('wsh-01', at('12:01'), E1),
      cycle('cnc-01', '11:45'),
    );
    expect(changes.some((c) => c.equipment === 'cnc-02')).toBe(true);
    expect(changes.some((c) => c.equipment === 'cnc-01' && c.from.getTime() === at('11:00'))).toBe(
      true,
    );
    const stops = await equipment.stopPieces(date('12:00'), date('13:00'), { equipment: 'cnc-02' });
    expect(stops.map((s) => [s.wholeMs, s.open])).toEqual([[MINUTE, true]]);
    const current = await oee.current('equipment', 'cnc-02');
    expect(current.hour?.key).toBe('2026-10-12T12:00:00.000Z');
    expect(current.hour?.result.provisional).toBe(true);
    expect(current.hour?.final).toBe(false);
    expect(current.shift?.key).toBe('2026-10-12/B');

    // At the threshold the stop becomes availability loss and a downtime record.
    await send(feed.telemetry('wsh-01', at('12:05'), E1));
    await equipment.flush();
    await feedOfRecords.settle();
    // Idle after the shift end opened records too; the stop's are those of interest here.
    const stopEvents = () =>
      events
        .filter((e) => e.record.state === 'Stopped')
        .map((e) => [e.event, e.record.equipment, e.record.end?.toISOString() ?? null]);
    expect(stopEvents()).toEqual([['created', 'cnc-02', null]]);
    await send(state('cnc-02', '12:10', 'Running'));
    await feedOfRecords.settle();
    expect(stopEvents()).toEqual([
      ['created', 'cnc-02', null],
      ['closed', 'cnc-02', '2026-10-12T12:10:00.000Z'],
    ]);
    const after = await oee.current('equipment', 'cnc-02');
    expect(after.hour?.result.provisional).toBe(false);
    expect(after.hour?.result.losses?.availability.own.stopped).toBe(BigInt(10 * MINUTE));
    feedOfRecords.stop();
    stopListening();
  });

  it('reports nothing final when the refresh state moved during both reads', async () => {
    const query = {
      scope: 'equipment' as const,
      id: 'cnc-01',
      bucket: 'shift' as const,
      from: date('03:00'),
      to: date('11:00'),
    };
    const [steady] = await oee.buckets(query);
    expect(steady?.final).toBe(true);
    // A refresh finishing between every sample: each read overlaps one.
    let generation = 0;
    const moving = new Oee({
      equipment,
      ingest: {
        cycleHourly: (...args: Parameters<Ingest['cycleHourly']>) => ingest.cycleHourly(...args),
        cyclesRefreshed: (hour: Date) => ingest.cyclesRefreshed(hour),
        onStored: (listener: Parameters<Ingest['onStored']>[0]) => ingest.onStored(listener),
        cycleAggregate: () => ({
          refreshedThrough: null,
          dirty: [],
          refreshes: generation,
          failures: 0,
          generation: generation++,
        }),
      },
      masterData,
      shiftPattern: oee.shiftPattern,
      config: plant.oee,
      idealCycleMs: idealCycleMs(plant),
    });
    const [unsettled] = await moving.buckets(query);
    expect(unsettled?.result).toEqual(steady?.result);
    expect(unsettled?.final).toBe(false);
    expect(generation).toBe(4); // sampled before and after, read twice
  });

  it('reads one epoch for a whole work center: the newest any of its machines has', async () => {
    // CNC-02 restarts into a newer run during shift A; the others stay in E1.
    const E2 = E1 + 3_600;
    await send(
      feed.state('cnc-02', E2, 1, at('10:00'), 'Running'),
      feed.state('cnc-02', E2, 2, at('10:30'), 'Idle'),
    );
    await refresh();
    const query = {
      scope: 'work-center' as const,
      id: 'cell-m1',
      bucket: 'shift' as const,
      from: date('03:00'),
      to: date('11:00'),
    };
    const [cell] = await oee.buckets(query);
    expect(cell?.members).toEqual([{ equipment: 'cnc-02', epoch: E2 }]);
    expect(cell?.final).toBe(false); // the others have no data in E2
    const [older] = await oee.buckets({ ...query, epoch: E1 });
    expect(older?.members.map((m) => m.equipment)).toEqual(['cnc-01', 'cnc-02', 'wsh-01']);
    // An equipment keeps its own newest epoch.
    const [machine] = await oee.buckets({ ...query, scope: 'equipment', id: 'cnc-01' });
    expect(machine?.members).toEqual([{ equipment: 'cnc-01', epoch: E1 }]);
  });
});
