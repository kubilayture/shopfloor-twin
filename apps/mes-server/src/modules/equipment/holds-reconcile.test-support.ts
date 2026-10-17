/**
 * Test support: the golden hold cases (#201, Phase 8 plan "Ground truth and reconciliation",
 * exit criterion 4 without the broker). In `quality-01`'s in-order replay, at the cut (Monday
 * 14:00 Istanbul) three scripted holds open with `opened_plant_at` set to the cut: one on a lot still
 * in use (consumed before and after the cut), one on a closed carton, one on a completed order.
 * Once every fact is delivered, each hold's scope equals the truth's units of its subject, the lot
 * hold's included those reported after it, with one `held-material-consumed` per consumption after
 * the cut; the held order's close is refused (409 `quality-hold`) until every hold is decided; every
 * opening and decision is notified to the ERP exactly once.
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

/** The scripted holds as opened at the cut. */
export interface ScriptedHolds {
  readonly cut: number;
  readonly lot: HoldRecord;
  readonly carton: HoldRecord;
  readonly order: HoldRecord;
}

/** What the hold cases compare, pinned. */
export interface HoldPins {
  readonly lot: string;
  /** The lot's units at the cut, and in the end (the truth's units of the lot). */
  readonly lotUnitsAtCut: number;
  readonly lotUnits: number;
  /** Consumptions of the lot after the cut: `held-material-consumed`. */
  readonly consumedAfter: number;
  readonly carton: string;
  readonly cartonUnits: number;
  readonly order: string;
  readonly orderUnits: number;
}

interface Context {
  readonly holds: Holds;
  readonly orders: Orders;
  readonly quality: { readonly by: WriteBy; readonly requestId: string };
  readonly supervisor: { readonly by: WriteBy; readonly requestId: string };
}

/** Consumption times (plant ms) of every lot, with the part and record, from the expected trace. */
function consumptions(expected: TraceProjection) {
  const byLot = new Map<
    string,
    { partId: number; at: number; operation: string; pass: number }[]
  >();
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

/**
 * At the cut, with every fact before it delivered and the MES up to date: opens the three holds,
 * each at the cut's plant time, and checks their scopes against the cut truth.
 */
export async function openScriptedHolds(
  context: Context,
  expected: TraceProjection,
  atCut: TraceProjection,
  cut: number,
): Promise<ScriptedHolds> {
  const used = consumptions(expected);
  const lot = [...used.keys()].sort().find((id) => {
    const times = used.get(id)?.map((c) => c.at) ?? [];
    return times.some((t) => t < cut) && times.some((t) => t > cut);
  });
  if (lot === undefined) throw new Error('no lot in use across the cut');
  const carton = atCut.cartons
    .filter((c) => c.status === 'closed')
    .map((c) => c.id)
    .sort()[0];
  if (carton === undefined) throw new Error('no closed carton at the cut');
  const completed = (await context.orders.list({ status: ['completed'] })).orders.map((o) => o.id);
  const order = completed.sort()[0];
  if (order === undefined) throw new Error('no order completed at the cut');
  const at = new Date(cut);
  const open = (subject: { kind: 'lot' | 'carton' | 'order'; id: string }, reason: string) =>
    context.holds.open({ subject, reason }, context.quality, { plantAt: at });
  const scripted = {
    cut,
    lot: await open({ kind: 'lot', id: lot }, 'SUSPECT-LOT'),
    carton: await open({ kind: 'carton', id: carton }, 'CUSTOMER-COMPLAINT'),
    order: await open({ kind: 'order', id: order }, 'OTHER'),
  };
  const lotAtCut = atCut.lots.find((l) => l.lot === lot)?.units ?? [];
  expect(scripted.lot.scope.units).toBe(new Set(lotAtCut).size);
  expect(scripted.lot.openedPlantAt?.getTime()).toBe(cut);
  expect(scripted.carton.scope.units).toBe(
    atCut.cartons.find((c) => c.id === carton)?.members.length,
  );
  return scripted;
}

/**
 * Once every fact is delivered: each hold's scope equals the truth's units of its subject (the lot
 * hold's grew past the cut), `held-material-consumed` once per consumption after the cut, the held
 * order's close refused until every hold is decided, and every notification posted once.
 */
export async function expectScriptedHolds(
  context: Context,
  scripted: ScriptedHolds,
  expected: TraceProjection,
  posts: readonly { readonly kind: string; readonly key: string; readonly body: unknown }[],
  postAll: () => Promise<void>,
): Promise<HoldPins> {
  await context.holds.tick();
  const unitsOf = async (hold: HoldRecord) =>
    ((await context.holds.detail(hold.id))?.units ?? []).map((u) => u.partId).sort((a, b) => a - b);
  const sorted = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);
  const lot = scripted.lot.subject.id;
  const lotUnits = await unitsOf(scripted.lot);
  expect(lotUnits).toEqual(sorted(expected.lots.find((l) => l.lot === lot)?.units ?? []));
  const after = (consumptions(expected).get(lot) ?? []).filter((c) => c.at > scripted.cut);
  const incidents = (await context.holds.detail(scripted.lot.id))?.incidents ?? [];
  expect(
    incidents
      .map((i) => [i.partId, i.operation, i.pass, i.consumedAt.getTime()])
      .sort((a, b) => Number(a[3]) - Number(b[3]) || Number(a[0]) - Number(b[0])),
  ).toEqual(
    after
      .map((c) => [c.partId, c.operation, c.pass, c.at])
      .sort((a, b) => Number(a[3]) - Number(b[3]) || Number(a[0]) - Number(b[0])),
  );
  const carton = scripted.carton.subject.id;
  const cartonUnits = await unitsOf(scripted.carton);
  expect(cartonUnits).toEqual(sorted(expected.cartons.find((c) => c.id === carton)?.members ?? []));
  const order = scripted.order.subject.id;
  const orderUnits = await unitsOf(scripted.order);
  expect(orderUnits).toEqual(
    sorted(expected.units.filter((u) => u.orderId === order).map((u) => u.partId)),
  );
  // The held order's close is refused while any of its holds is open.
  const close = async () => {
    const current = await context.orders.order(order);
    return context.orders.close(order, { version: current?.version ?? 0 }, context.supervisor);
  };
  await expect(close()).rejects.toMatchObject({ type: PROBLEM_TYPES.qualityHold });
  const decide = (hold: HoldRecord, decision: 'release' | 'reject', reason: string) =>
    context.holds.decide(hold.id, decision, { version: hold.version, reason }, context.quality);
  await decide(scripted.order, 'release', 'CONFORMS');
  await decide(scripted.lot, 'release', 'CONCESSION');
  await decide(scripted.carton, 'reject', 'NONCONFORMING');
  // Every hold decided: the guard passes; the operations were not signed off at a terminal here.
  await expect(close()).rejects.toMatchObject({ type: PROBLEM_TYPES.signOffMissing });
  await postAll();
  await postAll();
  const expectedKeys = [
    qualityNotificationKey(scripted.lot.id, 'opened', 1),
    qualityNotificationKey(scripted.carton.id, 'opened', 1),
    qualityNotificationKey(scripted.order.id, 'opened', 1),
    qualityNotificationKey(scripted.order.id, 'released', 2),
    qualityNotificationKey(scripted.lot.id, 'released', 2),
    qualityNotificationKey(scripted.carton.id, 'rejected', 2),
  ];
  const notified = posts.filter((p) => p.kind === 'quality-notification');
  expect(notified.map((p) => p.key)).toEqual(expectedKeys);
  for (const post of notified) qualityNotificationRequestSchema.parse(post.body);
  return {
    lot,
    lotUnitsAtCut: scripted.lot.scope.units,
    lotUnits: lotUnits.length,
    consumedAfter: after.length,
    carton,
    cartonUnits: cartonUnits.length,
    order,
    orderUnits: orderUnits.length,
  };
}
