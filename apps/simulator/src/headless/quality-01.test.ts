/**
 * The golden scenario `quality-01` (#208, Phase 8 plan "Golden scenario `quality-01`"): the week-01
 * seed and start, two days in orders mode, its own small-lot stock equal to its ERP dataset's lots,
 * the dispatch rule's dispatches, and one bounded `leak-drift` of +0.6 Pa/min on LKT-01 in Monday's
 * shift A after the SPC baseline. Asserted here: the counts exit criterion 3 rests on (first-pass
 * readings in shift A, the baseline, the readings before and after the drift's start, N), the
 * drift's first episode within 20 readings, a clean counterfactual window (exact, from the log, and
 * equal to the plain run's draws), every required feature of the plan, and the shift-A reference
 * run (end Monday 14:00 Istanbul) as a prefix of the full run whose trace is `traceAsOf` the full
 * trace at 14:00.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { erpDatasetSchema } from '@shopfloor/contracts/erp-api';
import { traceAsOf, type Trace } from '@shopfloor/trace-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatchRule } from './dispatch-rule.test-support.ts';
import { searchDriftStarts } from './drift-search.ts';
import { readScenario, scenarioOptions } from './golden.ts';
import {
  runHeadless,
  summaryDocument,
  traceDocument,
  type HeadlessOptions,
  type HeadlessResult,
} from './run.ts';
import { DEFAULT_DRIFT_WINDOW, analyseDrifts, type DriftAnalysis } from './trace-truth.ts';

const GOLDEN = resolve(import.meta.dirname, '../../golden');
/** Monday's shift A: 06:00–14:00 Istanbul. */
const SHIFT_A = {
  from: Date.parse('2026-10-12T03:00:00Z'),
  to: Date.parse('2026-10-12T11:00:00Z'),
};
const DRIFT_AT = Date.parse('2026-10-12T08:25:00Z');
const DRIFT_UNTIL = Date.parse('2026-10-12T10:50:00Z');

type LoggedEvent = Record<string, unknown> & { readonly type: string; readonly at: string };

let options: HeadlessOptions;
let lines: string[];
let result: HeadlessResult;
let trace: Trace;
let drift: DriftAnalysis;
let events: LoggedEvent[];

beforeAll(async () => {
  options = await scenarioOptions('quality-01');
  lines = [];
  result = runHeadless({ ...options, checkInvariants: true }, (line) => lines.push(line));
  trace = result.trace.trace;
  events = lines.slice(1).map((line) => JSON.parse(line) as LoggedEvent);
  const [analysis] = analyseDrifts(result.trace);
  if (!analysis) throw new Error('no drift');
  drift = analysis;
}, 60_000);

const scenario = () => readScenario('quality-01');
const inShiftA = (at: number) => at >= SHIFT_A.from && at < SHIFT_A.to;

describe('golden scenario quality-01 (#208)', () => {
  it('runs the week-01 seed and start for two days in orders mode, and the committed files are this run', async () => {
    const week = readScenario('week-01');
    const s = scenario();
    expect([s.seed, s.start, s.days, s.production, s.stock]).toEqual([
      week.seed,
      week.start,
      2,
      'orders',
      'stock.yaml',
    ]);
    expect(result.invariantChecks).toBeGreaterThan(1_000);
    expect(summaryDocument(result)).toBe(
      await readFile(resolve(GOLDEN, 'quality-01/summary.json'), 'utf8'),
    );
    expect(traceDocument(result)).toBe(
      await readFile(resolve(GOLDEN, 'quality-01/trace.json'), 'utf8'),
    );
  });

  it('has one bounded leak-drift on LKT-01 and no failure injection', () => {
    expect(scenario().injections).toEqual([
      {
        kind: 'leak-drift',
        at: '2026-10-12T08:25:00Z',
        until: '2026-10-12T10:50:00Z',
        machine: 'lkt-01',
        shift: 0.6,
      },
    ]);
    expect(result.header.injections).toEqual([
      {
        kind: 'leak-drift',
        at: '2026-10-12T08:25:00.000Z',
        until: '2026-10-12T10:50:00.000Z',
        machine: 'lkt-01',
        shift: 0.6,
      },
    ]);
    expect(events.filter((e) => e.type.startsWith('injection-'))).toEqual([]);
    expect(
      events
        .filter((e) => e.type === 'leak-drift')
        .map((e) => [e.at, e.transition, e.shift, e.endedBy]),
    ).toEqual([
      ['2026-10-12T08:25:00.000Z', 'applied', 0.6, undefined],
      ['2026-10-12T10:50:00.000Z', 'ended', 0.6, 'until'],
    ]);
  });

  it("serves its own stock as the ERP dataset's lots, and dispatches what the dispatch rule makes of it", async () => {
    const dataset = erpDatasetSchema.parse(
      JSON.parse(await readFile(resolve(GOLDEN, 'quality-01/orders.json'), 'utf8')),
    );
    expect(dataset.lots).toEqual(options.config.stock.lots);
    // Small lots, unlike the plant's stock.yaml (one or two lots of 900 or more per material).
    expect(options.config.stock.lots.length).toBeGreaterThan(20);
    const { erp } = scenario();
    expect(erp?.dataset).toBe('orders.json');
    expect(erp?.release).toEqual([...new Set(dataset.orders.map((o) => o.orderNumber))]);
    expect(dispatchRule(dataset.orders, erp?.release ?? [])).toEqual(scenario().dispatches);
    // Stock covers every dispatched job: no lot runs dry, no MATERIAL starvation.
    const demand = new Map<string, number>();
    const products = new Map(options.config.products.products.map((p) => [p.id, p]));
    for (const d of scenario().dispatches ?? []) {
      const product = products.get(d.product);
      for (const material of [product?.blank ?? '', ...(product?.components ?? [])]) {
        demand.set(material, (demand.get(material) ?? 0) + d.quantity);
      }
    }
    for (const [material, quantity] of demand) {
      const stock = options.config.stock.lots
        .filter((lot) => lot.material === material)
        .reduce((sum, lot) => sum + lot.quantity, 0);
      expect(stock, material).toBeGreaterThan(quantity);
    }
    expect(
      events.filter((e) => typeof e.cause === 'string' && e.cause.startsWith('MATERIAL:')),
    ).toEqual([]);
  });

  it('has the counts exit criterion 3 rests on: 155 first-pass readings in shift A, the baseline before the drift, 40 before and 20 after', () => {
    const firstPass = trace.spc.chart.firstPass;
    const shiftA = firstPass.filter((r) => inShiftA(r.at));
    expect(shiftA).toHaveLength(155);
    expect(shiftA.length).toBeGreaterThanOrEqual(140);
    // The baseline: 20 subgroups of 5, the first 100 first-pass readings, complete before the drift.
    const [v1, ...later] = trace.spc.limits;
    expect(later).toEqual([]);
    expect(v1?.limits.counts).toEqual({ readings: 100, movingRanges: 99, subgroups: 20 });
    expect(v1?.createdAt).toBe(firstPass[99]?.at);
    expect(new Date(v1?.createdAt ?? 0).toISOString()).toBe('2026-10-12T08:16:29.651Z');
    expect(v1?.createdAt).toBeLessThan(DRIFT_AT);
    // The start: the first first-pass reading after the applied line.
    expect(drift.drift).toMatchObject({ appliedAt: DRIFT_AT, endedAt: DRIFT_UNTIL, steps: 600 });
    expect(drift.startIndex).toBe(104);
    expect(drift.startIndex).toBeGreaterThanOrEqual(100);
    expect(drift.start?.at).toBeGreaterThan(DRIFT_AT);
    expect(firstPass[drift.startIndex - 1]?.at).toBeLessThan(DRIFT_AT);
    const before = shiftA.filter((r) => firstPass.indexOf(r) < drift.startIndex).length;
    const after = shiftA.length - before;
    expect([before, after]).toEqual([104, 51]);
    expect(after).toBeGreaterThanOrEqual(40);
    // N = 40 (the plan's window, not the fallback): 40 before the start and 20 after it.
    expect(DEFAULT_DRIFT_WINDOW).toEqual({ before: 40, after: 20 });
    expect([drift.window.before, drift.window.after]).toEqual([40, 20]);
    expect(drift.window.readings.every(({ reading }) => inShiftA(reading.at))).toBe(true);
  });

  it('detects the drift within 20 first-pass readings: I chart, rule 1, the second reading', () => {
    expect(drift.firstEpisode).toMatchObject({ chart: 'I', rule: 1, version: 1, baseline: false });
    expect(drift.latency).toBe(2);
    expect(drift.latency).toBeLessThanOrEqual(20);
    // No episode at all between the baseline and the drift's start.
    expect(
      trace.spc.chart.episodes.filter(
        (e) => e.position.at < (drift.start?.at ?? 0) && e.position.at > SHIFT_A.from,
      ),
    ).toEqual([]);
  });

  it('opens no episode on the counterfactual readings in the window, which the log gives exactly', () => {
    expect(drift.counterfactualSignals).toEqual([]);
    expect(drift.counterfactualEpisodes).toEqual([]);
    // Independently from the log: steps minus 600 between the applied and ended lines, in log order.
    let active = 0;
    const fromLog = new Map<string, number>();
    const passes = new Map<number, number>();
    for (const e of events) {
      if (e.type === 'leak-drift') active += e.transition === 'applied' ? 600 : -600;
      if (e.type === 'cycle-complete' && e.machineId === 'lkt-01') {
        const partId = e.partId as number;
        const pass = (passes.get(partId) ?? 0) + 1;
        passes.set(partId, pass);
        const steps = Math.round((e.measurement as { value: number }).value * 1000);
        fromLog.set(`0/${String(partId)}/${String(pass)}`, steps - active);
      }
    }
    expect(
      drift.window.readings.map(({ reading, counterfactual }) => [reading.key, counterfactual]),
    ).toEqual(drift.window.readings.map(({ reading }) => [reading.key, fromLog.get(reading.key)]));
    const drifted = drift.window.readings.filter(
      ({ reading, counterfactual }) => reading.value !== counterfactual,
    );
    expect(drifted.map(({ reading }) => reading.key)).toEqual(
      drift.window.readings.slice(40).map(({ reading }) => reading.key),
    );
    expect(
      drifted.every(({ reading, counterfactual }) => reading.value - counterfactual === 600),
    ).toBe(true);
  });

  it("gives the counterfactual of each drifted reading as the plain run's same draw, and the plain run before the start", () => {
    const plain: string[] = [];
    runHeadless({ ...options, injections: [] }, (line) => plain.push(line));
    const applied = lines.findIndex((line) => line.includes('"type":"leak-drift"'));
    expect(plain.slice(1, applied)).toEqual(lines.slice(1, applied));
    // The leak tester's k-th measurement draws the k-th normal of its stream in both runs; while
    // the two runs measure at the same instants (until the drift's first rework changes the line),
    // the counterfactual is exactly the plain run's reading.
    const measured = (log: string[]) =>
      log
        .slice(1)
        .map((line) => JSON.parse(line) as LoggedEvent)
        .filter((e) => e.type === 'cycle-complete' && e.machineId === 'lkt-01')
        .map((e) => ({
          at: e.at,
          steps: Math.round((e.measurement as { value: number }).value * 1000),
        }));
    const [withDrift, without] = [measured(lines), measured(plain)];
    const counterfactual = [...result.trace.counterfactual.values()];
    let compared = 0;
    for (let k = 0; k < withDrift.length && withDrift[k]?.at === without[k]?.at; k++) {
      expect(counterfactual[k], `measurement ${String(k)}`).toBe(without[k]?.steps);
      if ((withDrift[k]?.steps ?? 0) !== counterfactual[k]) compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(drift.latency ?? Infinity);
  });

  it('has every feature the plan requires', () => {
    const summary = result.summary.orders;
    const lotsOf = (partId: number, material: string, pass = 1) =>
      trace.units
        .find((u) => u.partId === partId)
        ?.records.filter((r) => r.pass === pass)
        .flatMap((r) => r.lots.filter((l) => l.material === material).map((l) => l.lot)) ?? [];
    const blank = (product: string) => (product === 'VB-100' ? 'BLANK-100' : 'BLANK-200');
    // A blank lot runs out inside an order: one order uses two blank lots, a carton holds both.
    const twoBlankLots = Object.keys(summary.orders).filter((orderId) => {
      const units = trace.units.filter((u) => u.orderId === orderId);
      return new Set(units.flatMap((u) => lotsOf(u.partId, blank(u.product)))).size > 1;
    });
    expect(twoBlankLots.length).toBeGreaterThanOrEqual(1);
    const mixedCartons = trace.cartons.filter(
      (c) => new Set(c.members.flatMap((m) => lotsOf(m.partId, blank(c.product)))).size > 1,
    );
    expect(mixedCartons.map((c) => c.id)).toContain('PO-2610-101-C02');
    // A seal-kit lot runs out inside an order, and one lot is used by two orders.
    const sealKitLots = (orderId: string) =>
      new Set(
        trace.units
          .filter((u) => u.orderId === orderId)
          .flatMap((u) => [...lotsOf(u.partId, 'SK-1'), ...lotsOf(u.partId, 'SK-2')]),
      );
    expect(
      Object.keys(summary.orders).filter((o) => sealKitLots(o).size > 1).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      trace.lots.filter((l) => l.material.startsWith('SK-') && l.orders.length > 1).length,
    ).toBeGreaterThanOrEqual(1);
    // A reworked unit whose rework pass took a seal kit from another lot than its first pass.
    const reworkedOtherLot = trace.units.filter((u) => {
      const first = lotsOf(u.partId, 'SK-1', 1);
      const second = lotsOf(u.partId, 'SK-1', 2);
      return second.length > 0 && second[0] !== first[0];
    });
    expect(reworkedOtherLot.length).toBeGreaterThanOrEqual(1);
    // A leak scrap (second failure), and the seed's OP10 DIMENSIONAL scraps.
    const scrapped = (operation: string) =>
      trace.units.filter((u) =>
        u.records.some((r) => r.operation === operation && r.result === 'scrap'),
      );
    const leak = scrapped('OP40');
    expect(leak.map((u) => [u.partId, u.orderId])).toEqual([[110, 'PO-2610-104']]);
    expect(leak[0]?.records.filter((r) => r.operation === 'OP40').map((r) => r.result)).toEqual([
      'rework',
      'scrap',
    ]);
    expect(scrapped('OP10').length).toBeGreaterThanOrEqual(1);
    expect(scrapped('OP10').every((u) => u.records[0]?.reason === 'DIMENSIONAL')).toBe(true);
    // At least two orders complete in shift A, with every carton closed.
    const completeInA = Object.entries(summary.orders)
      .filter(([, o]) => o.completedAt !== null && inShiftA(Date.parse(o.completedAt)))
      .map(([id]) => id);
    expect(completeInA).toEqual(['PO-2610-101', 'PO-2610-102']);
    for (const orderId of completeInA) {
      const cartons = trace.cartons.filter((c) => c.orderId === orderId);
      expect(cartons.length).toBeGreaterThan(0);
      expect(
        cartons.every((c) => c.status === 'closed' && (c.closedAt ?? Infinity) < SHIFT_A.to),
      ).toBe(true);
    }
    // A short order (packed good below its quantity) with a partial last carton.
    const short = summary.orders['PO-2610-104'];
    expect(short?.completedAt).not.toBeNull();
    expect([short?.packedGood, short?.quantity]).toEqual([59, 60]);
    const last = trace.cartons.filter((c) => c.orderId === 'PO-2610-104').at(-1);
    expect([last?.status, last?.members.length, last?.capacity]).toEqual(['closed', 19, 20]);
    // A unit in WIP at the end: the last order is not complete.
    const open = Object.entries(summary.orders).filter(([, o]) => o.completedAt === null);
    expect(open.map(([id]) => id)).toEqual(['PO-2610-107']);
    expect(trace.units.some((u) => u.status === 'wip')).toBe(true);
    expect(trace.cartons.some((c) => c.status === 'open')).toBe(true);
  });

  it('has a shift-A reference run (end Monday 14:00 Istanbul) whose log is a prefix of the full run and whose trace is traceAsOf 14:00', () => {
    const reference: string[] = [];
    const cut = runHeadless({ ...options, end: SHIFT_A.to }, (line) => reference.push(line));
    const header = JSON.parse(reference[0] ?? '{}') as { end: string };
    expect(header.end).toBe('2026-10-12T11:00:00.000Z');
    const body = reference.slice(1);
    expect(body.length).toBeGreaterThan(1_000);
    expect(lines.slice(1, 1 + body.length)).toEqual(body);
    expect(lines[1 + body.length]).toMatch(/"at":"2026-10-12T11:00:00\.000Z"/);
    // The three projections of exit criterion 5 compare through traceAsOf: the reference truth is
    // the full truth cut at 14:00.
    expect(traceAsOf(cut.trace.trace, SHIFT_A.to)).toEqual(cut.trace.trace);
    expect(traceAsOf(trace, SHIFT_A.to)).toEqual(cut.trace.trace);
  });

  it("reproduces probe P4's search around the chosen start", async () => {
    const rows = await searchDriftStarts('quality-01', {
      from: DRIFT_AT - 60_000,
      to: DRIFT_AT + 60_000,
      stepMs: 60_000,
      window: DEFAULT_DRIFT_WINDOW,
    });
    expect(
      rows.map((r) => [r.at, r.before, r.afterInShift, r.latency, r.counterfactualSignals, r.fits]),
    ).toEqual([
      ['2026-10-12T08:24:00.000Z', 103, 52, 3, 0, true],
      ['2026-10-12T08:25:00.000Z', 104, 51, 2, 0, true],
      ['2026-10-12T08:26:00.000Z', 104, 51, 2, 0, true],
    ]);
    const [, chosen] = rows;
    expect(chosen?.inShift).toBe(155);
    expect(chosen?.firstEpisode).toBe('I rule 1');
  }, 60_000);
});
