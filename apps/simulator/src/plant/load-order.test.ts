/**
 * Production mode `orders` and `LoadOrder` on the line (#172, ADR-0030): campaigns `[]`, the first
 * changeover `none→…`, FIFO jobs with `NotBefore`, job facts, `Idle NO-ORDER`, break-safe wake-ups,
 * idempotency with the dedup table checked first, and the device's epoch and expiry checks.
 */
import { CAUSES, MAX_QUEUED_JOBS } from '@shopfloor/contracts';
import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, MINUTE, RandomSource, Simulation } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ProductionLine,
  type LineEvent,
  type LoadOrderRequest,
  type PlantEvent,
  type ProductionMode,
} from './line.ts';
import { continuousOperation, loadDefaultConfig } from './testing.ts';

// Monday 06:00 Istanbul, the start of shift A (break 10:00–10:30 local = 07:00–07:30 UTC).
const T0 = Date.UTC(2026, 9, 12, 3);
const BREAK_START = Date.UTC(2026, 9, 12, 7);
const BREAK_END = Date.UTC(2026, 9, 12, 7, 30);
let defaults: PlantConfig;

beforeAll(async () => {
  defaults = await loadDefaultConfig();
});

interface Options {
  readonly production?: ProductionMode;
  readonly continuous?: boolean;
  readonly change?: (config: PlantConfig) => void;
}

function setup({ production = 'orders', continuous = true, change }: Options = {}) {
  const config = structuredClone(defaults);
  if (continuous) {
    continuousOperation(config);
  }
  config.failures.equipment = {};
  change?.(config);
  const events: PlantEvent[] = [];
  const line = new ProductionLine({
    config,
    random: new RandomSource(9),
    startTime: T0,
    production,
    onEvent: (e) => events.push(e),
  });
  const simulation = new Simulation<LineEvent>(T0);
  line.start(simulation);
  const runTo = (t: number) => {
    simulation.runUntil(t, (event, sim) => {
      line.handle(event, sim);
    });
  };
  return { line, simulation, events, runTo };
}

const job = (overrides: Partial<LoadOrderRequest> = {}): LoadOrderRequest => ({
  commandId: 'PO-1~OP10~1',
  orderId: 'PO-1',
  product: 'VB-100',
  quantity: 3,
  notBefore: T0,
  ...overrides,
});

const of = (events: readonly PlantEvent[], machineId: string) =>
  events.filter((e) => 'machineId' in e && e.machineId === machineId);

const states = (events: readonly PlantEvent[], machineId: string) =>
  of(events, machineId).flatMap((e) => (e.type === 'state' ? [e] : []));

const jobFacts = (events: readonly PlantEvent[]) =>
  events.flatMap((e) => (e.type === 'job' ? [`${e.commandId} ${e.transition}`] : []));

describe('production mode orders (#172)', () => {
  it('gives the CNCs campaigns [] and no loaded product; other stations keep none', () => {
    const { line } = setup();
    const cncs = line.stations.filter((s) => s.campaigns !== undefined).map((s) => s.id);
    expect(cncs).toEqual(['cnc-01', 'cnc-02']);
    for (const station of line.stations) {
      expect(station.campaigns ?? 'none').toEqual(station.id.startsWith('cnc') ? [] : 'none');
      expect(station.loadedProduct).toBeUndefined();
      expect(station.jobs !== undefined).toBe(station.id.startsWith('cnc'));
    }
    expect(line.production).toBe('orders');
  });

  it('keeps a CNC Idle NO-ORDER without a job, and runs nothing', () => {
    const { line, events, runTo } = setup();
    runTo(T0 + 2 * HOUR);
    expect(states(events, 'cnc-01').map((e) => `${e.to} ${String(e.cause)}`)).toEqual([
      `Idle ${CAUSES.noOrder}`,
    ]);
    expect(line.producedParts).toBe(0);
    expect(events.some((e) => e.type === 'cycle-complete')).toBe(false);
  });

  it('starts the first job with CHANGEOVER none→product, then runs the queue FIFO with job facts', () => {
    const { line, simulation, events, runTo } = setup();
    expect(line.loadOrder('cnc-01', job(), simulation)).toMatchObject({
      ok: true,
      duplicate: false,
      job: { position: 1, acceptedAt: T0, taken: 0 },
    });
    expect(
      line.loadOrder(
        'cnc-01',
        job({ commandId: 'PO-2~OP10~1', orderId: 'PO-2', product: 'VB-200', quantity: 2 }),
        simulation,
      ),
    ).toMatchObject({ ok: true, job: { position: 2 } });
    // The Idle NO-ORDER of the start and the Setup of the dispatch share the start time.
    expect(states(events, 'cnc-01').map((e) => [e.at, e.to, e.cause])).toEqual([
      [T0, 'Idle', CAUSES.noOrder],
      [T0, 'Setup', 'CHANGEOVER none→VB-100'],
    ]);
    runTo(T0 + 3 * HOUR);
    const cnc = of(events, 'cnc-01');
    const products = cnc.flatMap((e) => (e.type === 'cycle-complete' ? [e.product] : []));
    expect(products).toEqual(['VB-100', 'VB-100', 'VB-100', 'VB-200', 'VB-200']);
    expect(jobFacts(events)).toEqual([
      'PO-1~OP10~1 accepted',
      'PO-2~OP10~1 accepted',
      'PO-1~OP10~1 started',
      'PO-1~OP10~1 completed',
      'PO-2~OP10~1 started',
      'PO-2~OP10~1 completed',
    ]);
    // started = the first blank taken, after the changeover; completed = the last OP10 cycle's end.
    const started = cnc.find((e) => e.type === 'job' && e.transition === 'started');
    const firstBlank = cnc.find((e) => e.type === 'material-consumed');
    expect(started?.at).toBe(T0 + 25 * MINUTE);
    expect(firstBlank?.at).toBe(started?.at);
    const index = (pred: (e: PlantEvent) => boolean) => cnc.findIndex(pred);
    const lastFirstJobCycle = index(
      (e) => e.type === 'cycle-complete' && e.partId === 3 && e.machineId === 'cnc-01',
    );
    expect(cnc[lastFirstJobCycle + 1]).toMatchObject({
      type: 'job',
      commandId: 'PO-1~OP10~1',
      transition: 'completed',
    });
    const setups = states(events, 'cnc-01')
      .filter((e) => e.to === 'Setup')
      .map((e) => e.cause);
    expect(setups).toEqual(['CHANGEOVER none→VB-100', 'CHANGEOVER VB-100→VB-200']);
    expect(states(events, 'cnc-01').at(-1)).toMatchObject({ to: 'Idle', cause: CAUSES.noOrder });
    expect(line.queue('cnc-01')).toEqual([]);
    expect(line.jobs().map((j) => [j.commandId, j.taken, j.completedAt !== undefined])).toEqual([
      ['PO-1~OP10~1', 3, true],
      ['PO-2~OP10~1', 2, true],
    ]);
  });

  it('counts a job quantity in blanks started: OP10 scrap uses up a slot and the job still completes', () => {
    const { line, simulation, events, runTo } = setup({
      change: (config) => {
        config.process.tool.defectProbability = [
          { wear: 0, probability: 1 },
          { wear: 1, probability: 1 },
        ];
      },
    });
    line.loadOrder('cnc-01', job({ quantity: 2 }), simulation);
    runTo(T0 + 2 * HOUR);
    const cycles = of(events, 'cnc-01').flatMap((e) => (e.type === 'cycle-complete' ? [e] : []));
    expect(cycles.map((c) => c.result)).toEqual(['scrap', 'scrap']);
    expect(jobFacts(events).at(-1)).toBe('PO-1~OP10~1 completed');
    expect(line.producedParts).toBe(2);
  });

  it('holds the head job until its NotBefore and wakes the CNC then', () => {
    const { line, simulation, events, runTo } = setup();
    const notBefore = T0 + HOUR + 17 * MINUTE;
    line.loadOrder('cnc-01', job({ notBefore }), simulation);
    // A later job whose NotBefore has passed still waits behind the head (FIFO).
    line.loadOrder('cnc-01', job({ commandId: 'PO-3~OP10~1', orderId: 'PO-3' }), simulation);
    runTo(T0 + 3 * HOUR);
    const cnc = states(events, 'cnc-01');
    expect(cnc.slice(0, 2).map((e) => [e.at, e.to, e.cause])).toEqual([
      [T0, 'Idle', CAUSES.noOrder],
      [notBefore, 'Setup', 'CHANGEOVER none→VB-100'],
    ]);
    expect(jobFacts(events).slice(2, 4)).toEqual(['PO-1~OP10~1 started', 'PO-1~OP10~1 completed']);
  });

  describe('NotBefore and the 10:00–10:30 break (no start inside it, no zero-length interval)', () => {
    it.each([
      ['at the break start', BREAK_START],
      ['inside the break', BREAK_START + 10 * MINUTE],
      ['at the break end', BREAK_END],
    ])('starts a job whose NotBefore is %s at the break end', (_case, notBefore) => {
      const { line, simulation, events, runTo } = setup({ continuous: false });
      line.loadOrder('cnc-01', job({ notBefore }), simulation);
      runTo(BREAK_END + 2 * HOUR);
      const cnc = states(events, 'cnc-01');
      expect(cnc.slice(0, 4).map((e) => [e.at, e.to, e.cause])).toEqual([
        [T0, 'Idle', CAUSES.noOrder],
        [BREAK_START, 'PlannedStop', CAUSES.break],
        [BREAK_END, 'Setup', 'CHANGEOVER none→VB-100'],
        [BREAK_END + 25 * MINUTE, 'Running', undefined],
      ]);
      // Nothing starts inside the break, and only the start's Idle NO-ORDER has a sibling event at
      // the same instant (none here: the job waits, so the dispatch moves nothing).
      expect(
        events.some(
          (e) =>
            (e.type === 'job' && e.transition === 'started' && e.at < BREAK_END) ||
            (e.type === 'material-consumed' && e.at >= BREAK_START && e.at < BREAK_END),
        ),
      ).toBe(false);
      for (let i = 1; i < cnc.length; i++) {
        expect(cnc[i]?.at, `zero-length ${String(cnc[i - 1]?.to)}`).toBeGreaterThan(
          cnc[i - 1]?.at ?? 0,
        );
      }
    });

    it('starts nothing at a wake-up the event queue processes before the break boundary it falls on', () => {
      // Calendar boundaries are scheduled a week at a time: a break eight days ahead is scheduled
      // only after the wake-up, so at that instant the wake-up comes first, with the CNC still Idle.
      const breakStart = BREAK_START + 8 * 24 * HOUR;
      const { line, simulation, events, runTo } = setup({ continuous: false });
      line.loadOrder('cnc-01', job({ notBefore: breakStart }), simulation);
      runTo(breakStart + HOUR);
      const at = states(events, 'cnc-01').filter((e) => e.at >= breakStart);
      expect(at.map((e) => [e.at, e.to])).toEqual([
        [breakStart, 'PlannedStop'],
        [breakStart + 30 * MINUTE, 'Setup'],
        [breakStart + 55 * MINUTE, 'Running'],
      ]);
    });

    it('starts nothing for a dispatch during a break, before the break ends', () => {
      const { line, simulation, events, runTo } = setup({ continuous: false });
      runTo(BREAK_START + 5 * MINUTE);
      line.loadOrder('cnc-01', job({ notBefore: BREAK_START }), simulation);
      runTo(BREAK_END + HOUR);
      const cnc = states(events, 'cnc-01').filter((e) => e.at >= BREAK_START);
      expect(cnc.slice(0, 2).map((e) => [e.at, e.to])).toEqual([
        [BREAK_START, 'PlannedStop'],
        [BREAK_END, 'Setup'],
      ]);
    });
  });
});

describe('LoadOrder: idempotency and refusals (#172, ADR-0030)', () => {
  const guard = { epoch: 1_791_000_000, wallNow: 1_800_000_000_000 };
  const live = (overrides: Partial<LoadOrderRequest> = {}) =>
    job({ deviceEpoch: guard.epoch, expiresAt: guard.wallNow + 60_000, ...overrides });

  it('answers a repeated command id with the same job as a duplicate and adds nothing', () => {
    const { line, simulation, events } = setup();
    const first = line.loadOrder('cnc-01', live(), simulation, guard);
    const again = line.loadOrder(
      'cnc-01',
      live({ expiresAt: guard.wallNow + 1 }),
      simulation,
      guard,
    );
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(first.ok && again.ok && again.job.acceptedAt).toBe(first.ok && first.job.acceptedAt);
    expect(jobFacts(events)).toEqual(['PO-1~OP10~1 accepted']);
    expect(line.queue('cnc-01')).toHaveLength(1);
  });

  it('checks the dedup table first: a duplicate answers even when expired or for another epoch', () => {
    const { line, simulation } = setup();
    line.loadOrder('cnc-01', live(), simulation, guard);
    const late = line.loadOrder(
      'cnc-01',
      live({ expiresAt: guard.wallNow - 1, deviceEpoch: guard.epoch + 1 }),
      simulation,
      guard,
    );
    expect(late).toMatchObject({ ok: true, duplicate: true, job: { position: 1 } });
  });

  it('refuses the same command id with another job (command-conflict)', () => {
    const { line, simulation } = setup();
    line.loadOrder('cnc-01', live(), simulation, guard);
    for (const other of [{ quantity: 4 }, { product: 'VB-200' }, { notBefore: T0 + 1 }]) {
      expect(line.loadOrder('cnc-01', live(other), simulation, guard)).toMatchObject({
        ok: false,
        code: 'command-conflict',
        argument: 'CommandId',
      });
    }
  });

  it.each<[string, Partial<LoadOrderRequest>, string, string]>([
    ['another device epoch', { deviceEpoch: 1 }, 'epoch-mismatch', 'DeviceEpoch'],
    ['no device epoch', { deviceEpoch: undefined }, 'epoch-mismatch', 'DeviceEpoch'],
    ['an expiry in the past', { expiresAt: 1_799_999_999_999 }, 'expired', 'ExpiresAt'],
    ['an unknown product', { product: 'VB-999' }, 'invalid-product', 'Product'],
    ['a zero quantity', { quantity: 0 }, 'invalid-quantity', 'Quantity'],
    ['a fractional quantity', { quantity: 1.5 }, 'invalid-quantity', 'Quantity'],
    ['an empty command id', { commandId: '' }, 'invalid-argument', 'CommandId'],
    ['a padded order id', { orderId: ' PO-1' }, 'invalid-argument', 'OrderId'],
    ['an over-long order id', { orderId: 'X'.repeat(129) }, 'invalid-argument', 'OrderId'],
  ])('refuses %s on a miss, and accepts nothing', (_case, overrides, code, argument) => {
    const { line, simulation, events } = setup();
    expect(line.loadOrder('cnc-01', live(overrides), simulation, guard)).toMatchObject({
      ok: false,
      code,
      argument,
    });
    expect(events.some((e) => e.type === 'job')).toBe(false);
    expect(line.queue('cnc-01')).toEqual([]);
  });

  it('checks the epoch before the expiry, and both before the arguments', () => {
    const { line, simulation } = setup();
    const result = line.loadOrder(
      'cnc-01',
      live({ deviceEpoch: 2, expiresAt: 0, product: 'VB-999' }),
      simulation,
      guard,
    );
    expect(result).toMatchObject({ ok: false, code: 'epoch-mismatch' });
    expect(
      line.loadOrder('cnc-01', live({ expiresAt: 0, product: 'VB-999' }), simulation, guard),
    ).toMatchObject({ ok: false, code: 'expired' });
  });

  it(`refuses a job beyond ${String(MAX_QUEUED_JOBS)} queued ones`, () => {
    const { line, simulation } = setup();
    for (let n = 1; n <= MAX_QUEUED_JOBS; n++) {
      expect(line.loadOrder('cnc-02', job({ commandId: `C-${String(n)}` }), simulation).ok).toBe(
        true,
      );
    }
    expect(line.loadOrder('cnc-02', job({ commandId: 'C-51' }), simulation)).toMatchObject({
      ok: false,
      code: 'queue-full',
    });
  });

  it('refuses a station that is not a CNC, and LoadOrder in schedule mode', () => {
    const orders = setup();
    expect(orders.line.loadOrder('asm-01', job(), orders.simulation)).toMatchObject({
      ok: false,
      code: 'not-a-cnc',
    });
    const schedule = setup({ production: 'schedule' });
    expect(schedule.line.loadOrder('cnc-01', job(), schedule.simulation)).toMatchObject({
      ok: false,
      code: 'wrong-mode',
    });
  });

  it('refuses LoadProgram in orders mode', () => {
    const { line, simulation, events } = setup();
    expect(line.loadProgram('cnc-01', 'VB-100', 1, simulation)).toMatchObject({
      ok: false,
      code: 'wrong-mode',
    });
    expect(events.some((e) => e.type === 'program-loaded')).toBe(false);
  });
});
