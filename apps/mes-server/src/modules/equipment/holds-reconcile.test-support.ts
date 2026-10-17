/**
 * Test support: the golden hold cases (#201, Phase 8 plan "Ground truth and reconciliation",
 * exit criterion 4 without the broker). In `quality-01`'s in-order replay, at the cut (Monday
 * 14:00 Istanbul) four scripted holds open with `opened_plant_at` set to the cut: one on a blank
 * lot still in use (consumed before and after the cut), one on the seal-kit lot of a rework pass
 * (review of PR #222, M1), one on a closed carton, one on a completed order. The shuffled replay
 * opens the same holds (the lots and the order halfway through its deliveries, the carton once it
 * exists) and must reach the same ends (review L4). Once every fact is delivered, each hold's scope
 * equals the truth's units of its subject, the blank lot's included those reported after it, with
 * one `held-material-consumed` per consumption after the cut; the held order's close is refused
 * (409 `quality-hold`), and so is the close of a completed order covered only by the blank lot
 * hold's derived scope (review L4); every opening and decision is notified to the ERP once.
 */
import {
  qualityNotificationKey,
  qualityNotificationRequestSchema,
} from '@shopfloor/contracts/erp-api';
import { PROBLEM_TYPES } from '@shopfloor/contracts/mes-api';
import { expect } from 'vitest';
import type { WriteBy } from '../identity/index.ts';
import type { Orders } from '../orders/index.ts';
import type { HoldRecord, Holds } from '../quality/index.ts';
import type { TraceProjection } from './genealogy-reconcile.test-support.ts';

/** The scripted holds as opened. */
export interface ScriptedHolds {
  readonly cut: number;
  readonly lot: HoldRecord;
  readonly rework: HoldRecord;
  readonly order: HoldRecord;
  /** Opened at the cut in order; once it exists in the shuffled replay. */
  carton: HoldRecord | undefined;
}

/** What the hold cases compare, pinned. */
export interface HoldPins {
  readonly lot: string;
  /** The lot's units at the cut (in order), and in the end (the truth's units of the lot). */
  readonly lotUnitsAtCut: number;
  readonly lotUnits: number;
  /** Consumptions of the lot after the cut: `held-material-consumed`. */
  readonly consumedAfter: number;
  /** The seal-kit lot of the first rework pass, and its units in the end. */
  readonly reworkLot: string;
  readonly reworkLotUnits: number;
  readonly carton: string;
  readonly cartonUnits: number;
  readonly order: string;
  readonly orderUnits: number;
  /** A completed order covered by the blank lot hold alone: its close refused until released. */
  readonly lotOrder: string;
}

interface Context {
  readonly holds: Holds;
  readonly orders: Orders;
  readonly quality: { readonly by: WriteBy; readonly requestId: string };
  readonly supervisor: { readonly by: WriteBy; readonly requestId: string };
}

interface Consumption {
  readonly partId: number;
  readonly at: number;
  readonly operation: string;
  readonly pass: number;
}

/** Consumption times (plant ms) of every lot, with the part and record, from the expected trace. */
function consumptions(expected: TraceProjection): Map<string, Consumption[]> {
  const byLot = new Map<string, Consumption[]>();
  for (const unit of expected.units) {
    for (const record of unit.records) {
      for (const ref of record.lots) {
        const list = byLot.get(ref.lot) ?? [];
        list.push({
          partId: unit.partId,
          at: Date.parse(record.at),
          operation: record.operation,
          pass: record.pass,
        });
        byLot.set(ref.lot, list);
      }
    }
  }
  return byLot;
}

/** The subjects the in-order replay chooses (the shuffled one takes them from the pins). */
export function chooseSubjects(
  expected: TraceProjection,
  atCut: TraceProjection,
  cut: number,
  completed: readonly string[],
): { lot: string; reworkLot: string; carton: string; order: string } {
  const used = consumptions(expected);
  const lot = [...used.keys()].sort().find((id) => {
    const times = used.get(id)?.map((c) => c.at) ?? [];
    return times.some((t) => t < cut) && times.some((t) => t > cut);
  });
  if (lot === undefined) throw new Error('no lot in use across the cut');
  const reworkLot = [...used.entries()]
    .filter(([id, list]) => id !== lot && list.some((c) => c.pass > 1))
    .map(([id]) => id)
    .sort()[0];
  if (reworkLot === undefined) throw new Error('no lot consumed at a rework pass');
  const carton = atCut.cartons
    .filter((c) => c.status === 'closed')
    .map((c) => c.id)
    .sort()[0];
  if (carton === undefined) throw new Error('no closed carton at the cut');
  const order = [...completed].sort()[0];
  if (order === undefined) throw new Error('no order completed at the cut');
  return { lot, reworkLot, carton, order };
}

/**
 * Opens the scripted holds at the cut's plant time (and epoch). With `atCut` (in order, every fact
 * before the cut delivered and the MES up to date) their scopes are checked against the cut truth;
 * `carton: false` leaves the carton hold for later (the shuffled replay).
 */
export async function openScriptedHolds(
  context: Context,
  subjects: { lot: string; reworkLot: string; carton: string; order: string },
  cut: number,
  epoch: number,
  options: { readonly atCut?: TraceProjection; readonly carton?: boolean } = {},
): Promise<ScriptedHolds> {
  const at = new Date(cut);
  const open = (subject: { kind: 'lot' | 'carton' | 'order'; id: string }, reason: string) =>
    context.holds.open({ subject, reason }, context.quality, { plantAt: at, epoch });
  const scripted: ScriptedHolds = {
    cut,
    lot: await open({ kind: 'lot', id: subjects.lot }, 'SUSPECT-LOT'),
    rework: await open({ kind: 'lot', id: subjects.reworkLot }, 'SUSPECT-LOT'),
    order: await open({ kind: 'order', id: subjects.order }, 'OTHER'),
    carton:
      options.carton === false
        ? undefined
        : await open({ kind: 'carton', id: subjects.carton }, 'CUSTOMER-COMPLAINT'),
  };
  const atCut = options.atCut;
  if (atCut) {
    const lotAtCut = atCut.lots.find((l) => l.lot === subjects.lot)?.units ?? [];
    expect(scripted.lot.scope.units).toBe(new Set(lotAtCut).size);
    expect(scripted.lot.openedPlantAt?.getTime()).toBe(cut);
    expect(scripted.carton?.scope.units).toBe(
      atCut.cartons.find((c) => c.id === subjects.carton)?.members.length,
    );
  }
  return scripted;
}

/** Opens the carton hold if it was left for later (the carton exists once its order packs). */
export async function openCartonHold(
  context: Context,
  scripted: ScriptedHolds,
  carton: string,
  epoch: number,
): Promise<void> {
  scripted.carton ??= await context.holds.open(
    { subject: { kind: 'carton', id: carton }, reason: 'CUSTOMER-COMPLAINT' },
    context.quality,
    { plantAt: new Date(scripted.cut), epoch },
  );
}

/**
 * Once every fact is delivered: each hold's scope equals the truth's units of its subject (the
 * blank lot hold's grew past the cut), `held-material-consumed` once per consumption after the
 * cut, the held order's close refused, then a completed order's close refused by the blank lot
 * hold's derived scope alone, until every hold is decided; every notification posted once.
 */
export async function expectScriptedHolds(
  context: Context,
  scripted: ScriptedHolds,
  expected: TraceProjection,
  posts: readonly { readonly kind: string; readonly key: string; readonly body: unknown }[],
  postAll: () => Promise<void>,
): Promise<HoldPins> {
  const carton = scripted.carton;
  if (!carton) throw new Error('the carton hold was never opened');
  await context.holds.tick();
  const unitsOf = async (hold: HoldRecord) =>
    ((await context.holds.detail(hold.id))?.units ?? []).map((u) => u.partId).sort((a, b) => a - b);
  const sorted = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);
  const truthOfLot = (lot: string) => sorted(expected.lots.find((l) => l.lot === lot)?.units ?? []);
  const lot = scripted.lot.subject.id;
  const lotUnits = await unitsOf(scripted.lot);
  expect(lotUnits).toEqual(truthOfLot(lot));
  const after = (consumptions(expected).get(lot) ?? []).filter((c) => c.at > scripted.cut);
  const incidents = (await context.holds.detail(scripted.lot.id))?.incidents ?? [];
  const byTime = (a: (string | number | null)[], b: (string | number | null)[]) =>
    Number(a[3]) - Number(b[3]) || Number(a[0]) - Number(b[0]);
  expect(
    incidents.map((i) => [i.partId, i.operation, i.pass, i.consumedAt.getTime()]).sort(byTime),
  ).toEqual(after.map((c) => [c.partId, c.operation, c.pass, c.at]).sort(byTime));
  const reworkLot = scripted.rework.subject.id;
  const reworkUnits = await unitsOf(scripted.rework);
  expect(reworkUnits).toEqual(truthOfLot(reworkLot));
  const cartonId = carton.subject.id;
  const cartonUnits = await unitsOf(carton);
  expect(cartonUnits).toEqual(
    sorted(expected.cartons.find((c) => c.id === cartonId)?.members ?? []),
  );
  const order = scripted.order.subject.id;
  const orderUnits = await unitsOf(scripted.order);
  expect(orderUnits).toEqual(
    sorted(expected.units.filter((u) => u.orderId === order).map((u) => u.partId)),
  );
  const close = async (id: string) => {
    const current = await context.orders.order(id);
    return context.orders.close(id, { version: current?.version ?? 0 }, context.supervisor);
  };
  // The held order's close is refused while any of its holds is open.
  await expect(close(order)).rejects.toMatchObject({ type: PROBLEM_TYPES.qualityHold });
  const decide = (hold: HoldRecord, decision: 'release' | 'reject', reason: string) =>
    context.holds.decide(hold.id, decision, { version: hold.version, reason }, context.quality);
  await decide(scripted.order, 'release', 'CONFORMS');
  await decide(carton, 'reject', 'NONCONFORMING');
  await decide(scripted.rework, 'release', 'CONFORMS');
  // Only the blank lot hold is open: a completed order in its derived scope can't close.
  const lotOrders = (await context.holds.detail(scripted.lot.id))?.orders ?? [];
  const completed = (await context.orders.list({ status: ['completed'] })).orders.map((o) => o.id);
  const lotOrder = lotOrders.find((id) => completed.includes(id));
  if (lotOrder === undefined) throw new Error('no completed order in the lot hold’s scope');
  await expect(close(lotOrder)).rejects.toMatchObject({ type: PROBLEM_TYPES.qualityHold });
  await decide(scripted.lot, 'release', 'CONCESSION');
  // Every hold decided: the guard passes; the operations were not signed off at a terminal here.
  for (const id of new Set([order, lotOrder])) {
    await expect(close(id)).rejects.toMatchObject({ type: PROBLEM_TYPES.signOffMissing });
  }
  await postAll();
  await postAll();
  const notified = posts.filter((p) => p.kind === 'quality-notification');
  expect(notified.map((p) => p.key).sort()).toEqual(
    [
      qualityNotificationKey(scripted.lot.id, 'opened', 1),
      qualityNotificationKey(scripted.rework.id, 'opened', 1),
      qualityNotificationKey(scripted.order.id, 'opened', 1),
      qualityNotificationKey(carton.id, 'opened', 1),
      qualityNotificationKey(scripted.order.id, 'released', 2),
      qualityNotificationKey(carton.id, 'rejected', 2),
      qualityNotificationKey(scripted.rework.id, 'released', 2),
      qualityNotificationKey(scripted.lot.id, 'released', 2),
    ].sort(),
  );
  for (const post of notified) qualityNotificationRequestSchema.parse(post.body);
  return {
    lot,
    lotUnitsAtCut: scripted.lot.scope.units,
    lotUnits: lotUnits.length,
    consumedAfter: after.length,
    reworkLot,
    reworkLotUnits: reworkUnits.length,
    carton: cartonId,
    cartonUnits: cartonUnits.length,
    order,
    orderUnits: orderUnits.length,
    lotOrder,
  };
}
