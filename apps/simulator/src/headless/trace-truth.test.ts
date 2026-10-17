/**
 * The trace truth's fold on crafted event streams (#208): units, passes, lots and operators per
 * record, readings in steps, the device sequence, and the counterfactual readings, which subtract
 * a drift only between its `applied` and `ended` lines in log order.
 */
import type { PlantConfig } from '@shopfloor/plant-config';
import { DEFAULT_RULES } from '@shopfloor/spc-core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlantEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import type { OrdersSummary } from './order-truth.ts';
import {
  DEFAULT_DRIFT_WINDOW,
  TraceTruth,
  analyseDrifts,
  traceConfigHash,
  traceConfigOf,
  traceSection,
  traceUnits,
} from './trace-truth.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
const NO_ORDERS: OrdersSummary = { jobs: [], orders: {}, units: { count: 0, sha256: '' } };

let config: PlantConfig;

beforeAll(async () => {
  config = await loadDefaultConfig();
});

const consumed = (at: number, machineId: string, partId: number, material: string, lotId: string) =>
  ({ type: 'material-consumed', at, machineId, partId, material, lotId }) as const;

const cycle = (
  at: number,
  machineId: string,
  partId: number,
  result: 'good' | 'scrap' | 'rework' = 'good',
  extra: Partial<Extract<PlantEvent, { type: 'cycle-complete' }>> = {},
): PlantEvent => ({
  type: 'cycle-complete',
  at,
  machineId,
  product: 'VB-100',
  partId,
  serial: '',
  result,
  ...extra,
});

const leak = (value: number) => ({
  measurement: { characteristic: 'leak-rate', value, unit: 'Pa/min', upperLimit: 3.2 },
});

const drift = (
  at: number,
  transition: 'applied' | 'ended',
  shift = 0.6,
  injection = 1,
  endedBy?: 'until' | 'calibration',
): PlantEvent => ({
  type: 'leak-drift',
  at,
  machineId: 'lkt-01',
  injection,
  transition,
  shift,
  ...(endedBy === undefined ? {} : { endedBy }),
});

describe('trace configuration (#208)', () => {
  it('takes cartons from packing.yaml and the leak test characteristic from quality.yaml', () => {
    const traceConfig = traceConfigOf(config);
    expect(traceConfig).toEqual({
      packOperation: 'OP50',
      capacity: { 'VB-100': 20, 'VB-200': 12 },
      spc: {
        characteristic: 'leak-rate',
        operation: 'OP40',
        subgroupSize: 5,
        baselineSubgroups: 20,
        rules: { I: [1, 2, 5], MR: [], Xbar: [1, 2, 5], R: [1] },
      },
    });
    // quality.yaml's rules are spc-core's defaults (ADR-0032).
    expect(traceConfig.spc.rules).toEqual(DEFAULT_RULES);
    expect(traceConfigHash(traceConfig)).toMatch(/^[0-9a-f]{64}$/);
    const other = structuredClone(config);
    other.packing.capacity['VB-100'] = 25;
    expect(traceConfigHash(traceConfigOf(other))).not.toBe(traceConfigHash(traceConfig));
    other.quality.characteristics = [];
    expect(() => traceConfigOf(other)).toThrow(/no characteristic of the leak test/);
  });
});

describe('trace truth fold (#208)', () => {
  it('builds units with passes, lots, operator, readings in steps and device sequence', () => {
    const truth = new TraceTruth(config);
    const events: PlantEvent[] = [
      { type: 'operator', at: T0, machineId: 'asm-01', operatorId: 'OP-7', absent: [] },
      {
        type: 'state',
        at: T0,
        machineId: 'cnc-01',
        from: 'Off',
        to: 'Running',
      },
      consumed(T0 + 1, 'cnc-01', 1, 'BLANK-100', 'BL-A'),
      cycle(T0 + 2, 'cnc-01', 1, 'good', { serial: 'VB-100-000001' }),
      cycle(T0 + 3, 'wsh-01', 1),
      consumed(T0 + 4, 'asm-01', 1, 'SK-1', 'SK-A'),
      consumed(T0 + 4, 'asm-01', 1, 'SP-100', 'SP-A'),
      { type: 'operator', at: T0 + 5, machineId: 'asm-01', operatorId: 'OP-8', absent: [] },
      cycle(T0 + 6, 'asm-01', 1),
      cycle(T0 + 7, 'lkt-01', 1, 'rework', leak(3.301)),
      consumed(T0 + 8, 'asm-01', 1, 'SK-1', 'SK-B'),
      cycle(T0 + 9, 'asm-01', 1),
      cycle(T0 + 10, 'lkt-01', 1, 'good', leak(2.0)),
      cycle(T0 + 11, 'pck-01', 1),
    ];
    for (const event of events) truth.record(event);
    const result = truth.build(NO_ORDERS);
    const [unit] = traceUnits(result.trace);
    expect(unit).toMatchObject({
      partId: 1,
      serial: 'VB-100-000001',
      product: 'VB-100',
      orderId: null,
      status: 'packed',
      carton: null,
    });
    expect(
      unit?.records.map((r) => [r.operation, r.pass, r.result, r.lots, r.operator, r.reading]),
    ).toEqual([
      ['OP10', 1, 'good', [{ material: 'BLANK-100', lot: 'BL-A' }], null, null],
      ['OP20', 1, 'good', [], null, null],
      [
        'OP30',
        1,
        'good',
        [
          { material: 'SK-1', lot: 'SK-A' },
          { material: 'SP-100', lot: 'SP-A' },
        ],
        'OP-7',
        null,
      ],
      ['OP40', 1, 'rework', [], null, 3301],
      ['OP30', 2, 'good', [{ material: 'SK-1', lot: 'SK-B' }], 'OP-8', null],
      ['OP40', 2, 'good', [], null, 2000],
      ['OP50', 1, 'good', [], null, null],
    ]);
    // The device sequence: cnc-01's state fact is 1, its cycle 2.
    const records = result.trace.units[0]?.records ?? [];
    expect(records[0]?.seq).toBe(2);
    expect(records.filter((r) => r.machine === 'lkt-01').map((r) => r.seq)).toEqual([1, 2]);
    expect(result.trace.spc.readings.map((r) => [r.key, r.pass, r.value])).toEqual([
      ['0/1/1', 1, 3301],
      ['0/1/2', 2, 2000],
    ]);
    expect(result.trace.lots.map((l) => [l.lot, l.consumed])).toEqual([
      ['BL-A', 1],
      ['SK-A', 1],
      ['SK-B', 1],
      ['SP-A', 1],
    ]);
  });

  it('subtracts a drift only between its applied and ended lines, in log order', () => {
    const truth = new TraceTruth(config);
    const lkt = (at: number, partId: number, value: number): PlantEvent =>
      cycle(at, 'lkt-01', partId, 'good', leak(value));
    const events: PlantEvent[] = [
      lkt(T0 + 1, 1, 2.0),
      drift(T0 + 2, 'applied'),
      lkt(T0 + 3, 2, 2.6),
      // A second drift overlapping the first: both are subtracted while both are active.
      drift(T0 + 4, 'applied', -0.2, 2),
      lkt(T0 + 5, 3, 2.4),
      // A reading at the same instant as the end, logged before it, still carries the drift.
      lkt(T0 + 6, 4, 2.7),
      drift(T0 + 6, 'ended', 0.6, 1, 'calibration'),
      lkt(T0 + 6, 5, 1.8),
      drift(T0 + 7, 'ended', -0.2, 2, 'until'),
      lkt(T0 + 8, 6, 2.1),
    ];
    for (const event of events) truth.record(event);
    const result = truth.build(NO_ORDERS);
    expect([...result.counterfactual]).toEqual([
      ['0/1/1', 2000],
      ['0/2/1', 2000],
      ['0/3/1', 2000],
      ['0/4/1', 2300],
      ['0/5/1', 2000],
      ['0/6/1', 2100],
    ]);
    expect(result.drifts).toEqual([
      {
        injection: 1,
        machine: 'lkt-01',
        shift: 0.6,
        steps: 600,
        appliedAt: T0 + 2,
        endedAt: T0 + 6,
        endedBy: 'calibration',
        readingsBefore: 1,
      },
      {
        injection: 2,
        machine: 'lkt-01',
        shift: -0.2,
        steps: -200,
        appliedAt: T0 + 4,
        endedAt: T0 + 7,
        endedBy: 'until',
        readingsBefore: 2,
      },
    ]);
    const analyses = analyseDrifts(result, { before: 1, after: 2 });
    expect(analyses.map((a) => [a.startIndex, a.window.before, a.window.after])).toEqual([
      [1, 1, 2],
      [2, 1, 2],
    ]);
    expect(analyses[0]?.window.readings.map((r) => [r.reading.value, r.counterfactual])).toEqual([
      [2000, 2000],
      [2600, 2000],
      [2400, 2000],
    ]);
    // Too few readings for a baseline: no limits, no episode, nothing signals.
    expect(analyses[0]?.firstEpisode).toBeNull();
    expect(analyses[0]?.latency).toBeNull();
    expect(analyses[0]?.counterfactualSignals).toEqual([]);
    const section = traceSection(result, DEFAULT_DRIFT_WINDOW);
    expect(section.drifts[0]).toMatchObject({
      appliedAt: '2026-10-12T03:00:00.002Z',
      endedBy: 'calibration',
      start: { partId: 2, pass: 1, value: 2600, firstPassBefore: 1 },
      firstEpisode: null,
      window: { before: 1, after: 5 },
      counterfactual: { signals: [], episodes: [], clean: true },
    });
  });

  it('reports a drift still active at the end with no end, and one never followed by a reading', () => {
    const truth = new TraceTruth(config);
    truth.record(cycle(T0 + 1, 'lkt-01', 1, 'good', leak(2.0)));
    truth.record(drift(T0 + 2, 'applied'));
    const result = truth.build(NO_ORDERS);
    const [analysis] = analyseDrifts(result);
    expect(analysis?.drift.endedAt).toBeNull();
    expect(analysis?.start).toBeNull();
    expect(analysis?.window).toMatchObject({ before: 1, after: 0 });
    expect(traceSection(result).drifts[0]).toMatchObject({ endedAt: null, start: null });
  });

  it('refuses an ended line without its applied line, a shift off the resolution and an unknown machine', () => {
    expect(() => {
      new TraceTruth(config).record(drift(T0, 'ended'));
    }).toThrow(/ended before it was applied/);
    expect(() => {
      new TraceTruth(config).record(drift(T0, 'applied', 0.0005));
    }).toThrow(/shift 0.0005/);
    expect(() => {
      new TraceTruth(config).record(cycle(T0, 'xyz-01', 1));
    }).toThrow(/unknown machine xyz-01/);
  });

  it('gives a unit its CNC job order and packs it into the order cartons', () => {
    const truth = new TraceTruth(config);
    const job = (transition: 'accepted' | 'started'): PlantEvent => ({
      type: 'job',
      at: T0,
      machineId: 'cnc-01',
      transition,
      commandId: 'PO-1~OP10~1',
      orderId: 'PO-1',
      product: 'VB-100',
      quantity: 1,
    });
    for (const event of [
      job('accepted'),
      job('started'),
      consumed(T0 + 1, 'cnc-01', 1, 'BLANK-100', 'BL-A'),
      cycle(T0 + 2, 'cnc-01', 1),
      cycle(T0 + 3, 'pck-01', 1),
      // A part seen first downstream (impossible on the line) has no order.
      cycle(T0 + 4, 'pck-01', 2),
    ]) {
      truth.record(event);
    }
    const orders: OrdersSummary = {
      jobs: [],
      orders: {
        'PO-1': {
          product: 'VB-100',
          jobs: ['PO-1~OP10~1'],
          quantity: 1,
          started: 1,
          scrap: {},
          reworkPasses: 0,
          packedGood: 1,
          wip: {},
          lastTerminalAt: '2026-10-12T03:00:00.003Z',
          completedAt: '2026-10-12T03:00:00.003Z',
          operations: {},
          material: {},
          materialInProcess: {},
        },
      },
      units: { count: 1, sha256: '' },
    };
    const section = traceSection(truth.build(orders));
    expect(section.cartons).toEqual([
      {
        id: 'PO-1-C01',
        orderId: 'PO-1',
        product: 'VB-100',
        capacity: 20,
        status: 'closed',
        closedAt: '2026-10-12T03:00:00.003Z',
        members: { count: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown },
      },
    ]);
    expect(section.lots).toEqual([
      {
        lot: 'BL-A',
        material: 'BLANK-100',
        consumed: 1,
        units: [1],
        orders: ['PO-1'],
        cartons: ['PO-1-C01'],
      },
    ]);
    expect(section.units.count).toBe(2);
  });
});
