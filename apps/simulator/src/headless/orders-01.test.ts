/**
 * The golden scenario `orders-01` (#172, ADR-0030): the week-01 seed in production mode `orders`,
 * two days, alarms-01's 14 shift A injections and the jobs of its `dispatches`. Asserted here by
 * construction: what the Phase 7 reconciliations need (orders completed in shift A, a short order,
 * Idle NO-ORDER inside shifts, an order in WIP at the end, an ERP revision and an unreleased order),
 * that `dispatches` is the plan's dispatch rule applied to the released orders of `orders.json`,
 * and that the order ground truth equals what the event log shows. Also: week-01's and alarms-01's
 * regenerated summaries differ from a `shift-calendar` run only in the fields #172 changed.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CAUSES } from '@shopfloor/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { readScenario, scenarioOptions } from './golden.ts';
import { unitsHash, type UnitJson } from './order-truth.ts';
import { runHeadless, summaryDocument, type HeadlessResult } from './run.ts';

const GOLDEN = resolve(import.meta.dirname, '../../golden');
const MINUTE = 60_000;

interface Logged {
  readonly lines: string[];
  readonly result: HeadlessResult;
}

interface ErpOrder {
  readonly feed: number;
  readonly number: string;
  readonly revision: number;
  readonly product: string;
  readonly quantity: number;
  readonly plannedStart: string;
}

type LoggedEvent = Record<string, unknown> & {
  readonly type: string;
  readonly at: string;
  readonly machineId?: string;
};

let orders: Logged;
let events: LoggedEvent[];
let dataset: { readonly orders: readonly ErpOrder[] };

beforeAll(async () => {
  const options = await scenarioOptions('orders-01');
  const lines: string[] = [];
  const result = runHeadless({ ...options, checkInvariants: true }, (line) => lines.push(line));
  orders = { lines, result };
  events = lines.slice(1).map((line) => JSON.parse(line) as LoggedEvent);
  dataset = JSON.parse(await readFile(resolve(GOLDEN, 'orders-01/orders.json'), 'utf8')) as {
    orders: ErpOrder[];
  };
}, 60_000);

const scenario = () => readScenario('orders-01');

describe('golden scenario orders-01 (#172)', () => {
  it('records the production mode and the dispatches in its header, and the committed summary is this run', async () => {
    const header = JSON.parse(orders.lines[0] ?? '{}') as Record<string, unknown>;
    expect(header.production).toBe('orders');
    expect(header.dispatches).toEqual(scenario().dispatches);
    expect(orders.result.invariantChecks).toBeGreaterThan(1_000);
    expect(summaryDocument(orders.result)).toBe(
      await readFile(resolve(GOLDEN, 'orders-01/summary.json'), 'utf8'),
    );
    // Schedule-mode headers carry neither field, so week-01 and alarms-01 keep events.sha256.
    for (const name of ['week-01', 'alarms-01']) {
      const summary = JSON.parse(await readFile(resolve(GOLDEN, name, 'summary.json'), 'utf8')) as {
        run: Record<string, unknown>;
      };
      expect(summary.run).not.toHaveProperty('production');
      expect(summary.run).not.toHaveProperty('dispatches');
    }
  });

  it('dispatches exactly what the dispatch rule makes of the released orders of orders.json', () => {
    // The plan's rule (#174 implements it in the MES): released orders in planned-start order,
    // ties by order number, each whole order to the CNC whose queue with it appended finishes
    // first by ideal time (NotBefore waits and changeovers counted, `none→…` included); ties go
    // to the lower id.
    const { erp } = scenario();
    expect(erp?.dataset).toBe('orders.json');
    const latest = new Map<string, ErpOrder>();
    for (const order of [...dataset.orders].sort((a, b) => a.feed - b.feed)) {
      latest.set(order.number, order);
    }
    const released = [...latest.values()]
      .filter((order) => erp?.release.includes(order.number))
      .sort(
        (a, b) =>
          Date.parse(a.plannedStart) - Date.parse(b.plannedStart) || (a.number < b.number ? -1 : 1),
      );
    const ideal: Record<string, number> = { 'VB-100': 240_000, 'VB-200': 330_000 };
    const changeover = 25 * MINUTE;
    const queues = new Map<string, { product: string; quantity: number; notBefore: number }[]>([
      ['cnc-01', []],
      ['cnc-02', []],
    ]);
    const finish = (queue: { product: string; quantity: number; notBefore: number }[]) => {
      let end = Number.NEGATIVE_INFINITY;
      let loaded: string | undefined;
      for (const job of queue) {
        const start = Math.max(job.notBefore, end) + (job.product === loaded ? 0 : changeover);
        end = start + job.quantity * (ideal[job.product] ?? 0);
        loaded = job.product;
      }
      return end;
    };
    const dispatches = released.map((order) => {
      const job = {
        product: order.product,
        quantity: order.quantity,
        notBefore: Date.parse(order.plannedStart),
      };
      const [machine = ''] = [...queues.keys()].sort(
        (a, b) =>
          finish([...(queues.get(a) ?? []), job]) - finish([...(queues.get(b) ?? []), job]) ||
          (a < b ? -1 : 1),
      );
      queues.get(machine)?.push(job);
      return {
        commandId: `${order.number}~OP10~1`,
        machine,
        orderId: order.number,
        product: order.product,
        quantity: order.quantity,
        notBefore: new Date(job.notBefore).toISOString(),
      };
    });
    expect(dispatches).toEqual(scenario().dispatches);
  });

  it('holds what the Phase 7 reconciliations need', () => {
    const truth = orders.result.summary.orders;
    const completedBy = (order: string, at: string) => {
      const completedAt = truth.orders[order]?.completedAt;
      return completedAt !== null && completedAt !== undefined && completedAt < at;
    };
    // At least three orders complete inside Monday's shift A (06:00–14:00 Istanbul), small VB-100
    // and VB-200 orders on both CNCs, with a changeover (CNC-02: VB-200 → VB-100).
    const shiftA = Object.keys(truth.orders).filter((o) => completedBy(o, '2026-10-12T11:00'));
    expect(shiftA.length).toBeGreaterThanOrEqual(3);
    const machines = new Set(
      truth.jobs.filter((j) => shiftA.includes(j.orderId)).map((j) => j.machine),
    );
    expect([...machines].sort()).toEqual(['cnc-01', 'cnc-02']);
    expect(new Set(shiftA.map((o) => truth.orders[o]?.product))).toEqual(
      new Set(['VB-100', 'VB-200']),
    );
    expect(
      events.some(
        (e) =>
          e.type === 'state' && e.cause === 'CHANGEOVER VB-200→VB-100' && e.at < '2026-10-12T11:00',
      ),
    ).toBe(true);
    // A short order: complete, with fewer packed good than its quantity, through scrap.
    const short = Object.entries(truth.orders).filter(
      ([, o]) => o.completedAt !== null && o.packedGood < o.quantity,
    );
    expect(short.map(([id]) => id)).toEqual(['PO-2610-007']);
    expect(short[0]?.[1].scrap).toEqual({ OP10: { DIMENSIONAL: 1 } });
    // The Tuesday order at 11:17 Istanbul (08:17Z), outside the 10:00–10:30 break, after both
    // CNCs ran dry: Idle NO-ORDER inside shifts on both.
    const tuesday = scenario().dispatches?.filter(
      (d) => d.notBefore === '2026-10-13T08:17:00.000Z',
    );
    expect(tuesday?.map((d) => d.machine).sort()).toEqual(['cnc-01', 'cnc-02']);
    for (const machine of ['cnc-01', 'cnc-02']) {
      const lastMonday = truth.jobs
        .filter((j) => j.machine === machine && j.acceptedAt < '2026-10-13')
        .filter((j) => !tuesday?.some((d) => d.commandId === j.commandId))
        .map((j) => j.completedAt ?? '')
        .sort()
        .at(-1);
      expect(lastMonday && lastMonday < '2026-10-13T08:17').toBe(true);
      const shifts = orders.result.summary.oee.machines[machine]?.shifts ?? {};
      expect(shifts['2026-10-13/A']?.inputs.noOrderIdleMs).toBeGreaterThan(0);
      expect(shifts['2026-10-13/A']?.inputs.scheduled).toBe(true);
    }
    // An order still in WIP at the end, its job not completed, with material in process.
    const open = Object.entries(truth.orders).filter(([, o]) => o.completedAt === null);
    expect(open.map(([id]) => id)).toEqual(['PO-2610-009']);
    expect(Object.values(open[0]?.[1].wip ?? {}).reduce((s, n) => s + n, 0)).toBeGreaterThan(0);
    expect(truth.jobs.find((j) => j.orderId === 'PO-2610-009')?.completedAt).toBeNull();
    // The ERP dataset: a revision before release, and an order never released.
    const revised = dataset.orders.filter((o) => o.revision > 1).map((o) => o.number);
    expect(revised).toEqual(['PO-2610-006']);
    expect(scenario().erp?.release).toContain('PO-2610-006');
    const unreleased = [...new Set(dataset.orders.map((o) => o.number))].filter(
      (n) => !scenario().erp?.release.includes(n),
    );
    expect(unreleased).toEqual(['PO-2610-008']);
    expect(truth.jobs.some((j) => j.orderId === 'PO-2610-008')).toBe(false);
  });

  it('starts every CNC with nothing loaded: Idle NO-ORDER and Setup none→… at the start time, the Idle dropped', () => {
    const start = '2026-10-12T03:00:00.000Z';
    for (const machine of ['cnc-01', 'cnc-02']) {
      const atStart = events.filter(
        (e) => e.type === 'state' && e.machineId === machine && e.at === start,
      );
      expect(atStart.map((e) => [e.from, e.to, e.cause])).toEqual([
        ['Off', 'Idle', CAUSES.noOrder],
        ['Idle', 'Setup', expect.stringMatching(/^CHANGEOVER none→VB-[12]00$/)],
      ]);
      // A zero-length interval counts nowhere: shift A has no Idle time on either CNC up to its
      // first job's end.
      const firstHour = orders.result.summary.oee.machines[machine]?.hours[start];
      expect(firstHour?.stateMs.Idle).toBe(0);
      expect(firstHour?.noOrderIdleMs).toBeUndefined();
    }
    // `Program` stays empty until then: no `program-loaded`, no schedule.
    expect(events.some((e) => e.type === 'program-loaded')).toBe(false);
  });

  it('confirms every command by exactly one accepted job fact, within each order quantity', () => {
    const accepted = events.filter((e) => e.type === 'job' && e.transition === 'accepted');
    const ids = accepted.map((e) => e.commandId as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(scenario().dispatches?.map((d) => d.commandId));
    const perOrder = new Map<string, number>();
    for (const e of accepted) {
      const order = e.orderId as string;
      perOrder.set(order, (perOrder.get(order) ?? 0) + (e.quantity as number));
    }
    const latest = new Map(dataset.orders.map((o) => [o.number, o.quantity]));
    for (const [order, quantity] of perOrder) {
      expect(quantity).toBeLessThanOrEqual(latest.get(order) ?? 0);
    }
  });

  it('keeps the flood, the chattering point and the fleeting alarm of alarms-01 in orders mode', () => {
    const scopes = orders.result.summary.alarms.scopes;
    const shiftA = scopes['cell-m1']?.shifts['2026-10-12/A'];
    expect(shiftA?.floodWindows).toBeGreaterThanOrEqual(1);
    expect(scopes['cell-m1']?.floods.length).toBeGreaterThanOrEqual(1);
    expect(shiftA?.chatteringPoints).toEqual(['cnc-01/COOLANT-PRESSURE']);
    expect(scopes['line-a1']?.shifts['2026-10-12/A']).toMatchObject({ fleeting: 1 });
    expect(scenario().injections).toHaveLength(14);
  });

  it('equals the units, quantities and material the event log shows (material booked at cycle completion)', () => {
    // An independent reading of the event log: a part's order is its CNC's latest started job.
    const operation: Record<string, string> = {
      'cnc-01': 'OP10',
      'cnc-02': 'OP10',
      'wsh-01': 'OP20',
      'asm-01': 'OP30',
      'lkt-01': 'OP40',
      'pck-01': 'OP50',
    };
    const current = new Map<string, string>();
    const units = new Map<
      number,
      { serial: string; orderId: string; records: UnitJson['records'][number][]; reworks: number }
    >();
    const taken = new Map<string, string[]>();
    const booked = new Map<string, Map<string, number>>();
    const inProcess = new Map<string, Map<string, number>>();
    for (const e of events) {
      const machine = e.machineId ?? '';
      if (e.type === 'job' && e.transition === 'started') {
        current.set(machine, e.orderId as string);
      }
      const partId = e.partId as number;
      if ((e.type === 'material-consumed' || e.type === 'cycle-complete') && !units.has(partId)) {
        units.set(partId, {
          serial: '',
          orderId: current.get(machine) ?? '',
          records: [],
          reworks: 0,
        });
      }
      if (e.type === 'material-consumed') {
        const key = `${machine}/${String(partId)}`;
        taken.set(key, [...(taken.get(key) ?? []), e.material as string]);
      }
      if (e.type === 'cycle-complete') {
        const unit = units.get(partId);
        if (!unit) throw new Error('no unit');
        const op = operation[machine] ?? '';
        const result = e.result as 'good' | 'scrap' | 'rework';
        unit.records.push({
          operation: op,
          equipment: machine,
          pass: op === 'OP30' || op === 'OP40' ? unit.reworks + 1 : 1,
          at: e.at,
          result,
          ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
        });
        if (result === 'rework') unit.reworks++;
        if (e.serial !== '') unit.serial = e.serial as string;
        const key = `${machine}/${String(partId)}`;
        const perOrder = booked.get(unit.orderId) ?? new Map<string, number>();
        for (const material of taken.get(key) ?? []) {
          perOrder.set(material, (perOrder.get(material) ?? 0) + 1);
        }
        booked.set(unit.orderId, perOrder);
        taken.delete(key);
      }
    }
    for (const [key, materials] of taken) {
      const unit = units.get(Number(key.split('/')[1]));
      const perOrder = inProcess.get(unit?.orderId ?? '') ?? new Map<string, number>();
      for (const material of materials) perOrder.set(material, (perOrder.get(material) ?? 0) + 1);
      inProcess.set(unit?.orderId ?? '', perOrder);
    }
    const list: UnitJson[] = [...units]
      .sort(([a], [b]) => a - b)
      .map(([partId, u]) => ({ partId, serial: u.serial, orderId: u.orderId, records: u.records }));
    const truth = orders.result.summary.orders;
    expect(truth.units).toEqual({ count: list.length, sha256: unitsHash(list) });
    expect(list.every((u) => u.orderId !== '')).toBe(true);
    const sorted = (map: Map<string, number> | undefined) =>
      Object.fromEntries(
        [...(map ?? new Map<string, number>())].sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    for (const [id, order] of Object.entries(truth.orders)) {
      expect(order.material, id).toEqual(sorted(booked.get(id)));
      expect(order.materialInProcess, id).toEqual(sorted(inProcess.get(id)));
      const records = list.filter((u) => u.orderId === id).flatMap((u) => u.records);
      for (const [op, q] of Object.entries(order.operations)) {
        const at = records.filter((r) => r.operation === op);
        expect(q, `${id} ${op}`).toEqual({
          in: at.length,
          good: at.filter((r) => r.result === 'good').length,
          scrap: at.filter((r) => r.result === 'scrap').length,
          rework: at.filter((r) => r.result === 'rework').length,
        });
      }
      expect(order.reworkPasses).toBe(records.filter((r) => r.result === 'rework').length);
      expect(order.packedGood).toBe(
        records.filter((r) => r.operation === 'OP50' && r.result === 'good').length,
      );
      // A complete order booked one blank per unit and the BOM's components per OP30 pass.
      if (order.completedAt !== null) {
        const blank = order.product === 'VB-100' ? 'BLANK-100' : 'BLANK-200';
        expect(order.material[blank]).toBe(order.started);
        expect(order.started).toBe(order.quantity);
        expect(Object.keys(order.wip)).toEqual([]);
      }
    }
    // Rework passes exist (at OP30 and OP40, pass 2) in the run.
    expect(list.some((u) => u.records.some((r) => r.pass === 2))).toBe(true);
  });

  it('excludes Idle NO-ORDER from planned busy time under the orders rule (ADR-0021 amendment)', () => {
    let compared = 0;
    for (const machine of ['cnc-01', 'cnc-02']) {
      for (const [key, bucket] of Object.entries(
        orders.result.summary.oee.machines[machine]?.shifts ?? {},
      )) {
        const { stateMs, noOrderIdleMs = 0, scheduled } = bucket.inputs;
        const elapsed = Object.values(stateMs).reduce((s, n) => s + n, 0);
        const excluded = stateMs.PlannedStop + stateMs.Maintenance + stateMs.Off + noOrderIdleMs;
        expect(bucket.result.totals.plannedBusyMs, key).toBe(scheduled ? elapsed - excluded : 0);
        if (scheduled && noOrderIdleMs > 0) compared++;
      }
    }
    expect(orders.result.summary.oee.config.scheduledTime).toBe('orders');
    expect(compared).toBeGreaterThanOrEqual(6);
  });
});

describe('week-01 and alarms-01 under sim-summary/4 (#172, M6)', () => {
  it.each(['week-01', 'alarms-01'])(
    '%s: the committed summary is a shift-calendar run but for the schema, the rule, the hash and an empty orders section',
    async (name) => {
      const options = await scenarioOptions(name);
      const config = structuredClone(options.config);
      Object.assign(config.oee, { scheduledTime: 'shift-calendar' });
      const before = runHeadless({ ...options, config }, () => undefined);
      const committed = JSON.parse(
        await readFile(resolve(GOLDEN, name, 'summary.json'), 'utf8'),
      ) as Record<string, unknown> & {
        oee: { config: Record<string, unknown> };
        orders: unknown;
      };
      const previous = JSON.parse(summaryDocument(before)) as typeof committed;
      expect(committed.schema).toBe('sim-summary/4');
      expect(committed.oee.config.scheduledTime).toBe('orders');
      expect(previous.oee.config.scheduledTime).toBe('shift-calendar');
      expect(committed.orders).toEqual({
        jobs: [],
        orders: {},
        units: { count: 0, sha256: unitsHash([]) },
      });
      expect(committed.analysisConfigSha256).not.toBe(previous.analysisConfigSha256);
      // Every other field, OEE results included, is the same under both rules.
      for (const summary of [committed, previous]) {
        delete summary.analysisConfigSha256;
        delete summary.oee.config.scheduledTime;
      }
      expect(committed).toEqual(previous);
    },
    60_000,
  );
});
