/**
 * The packing rule (Phase 8 plan "Genealogy", ADR-0034): the MES forms cartons, and the ground
 * truth applies the same rule.
 *
 * Cartons are per order (an order has one product). An order's good cycles at the packing
 * operation fill its cartons in plant-time order (ties by device epoch, then sequence); a carton
 * closes when full, at its last member's time, and the order's last carton closes when the
 * order's packing operation is complete, so a short order has a partial carton. Ids are
 * `{orderId}-C{nn}`: the carton's number with at least two digits, growing past 99.
 * Units without an order (schedule mode) have no carton.
 */

/** Plant time in ms since the Unix epoch. */
export type Millis = number;

/** A unit: (device epoch, `partId`), as execution keys it (ADR-0031). */
export interface UnitKey {
  readonly epoch: number;
  readonly partId: number;
}

export const compareUnits = (a: UnitKey, b: UnitKey): number =>
  a.epoch - b.epoch || a.partId - b.partId;

export const unitId = (unit: UnitKey): string => `${String(unit.epoch)}/${String(unit.partId)}`;

/** A good cycle at the packing operation. */
export interface Pack {
  readonly unit: UnitKey;
  readonly orderId: string;
  readonly at: Millis;
  readonly seq: number;
}

export interface OrderPacking {
  readonly orderId: string;
  readonly product: string;
  /** When the order's packing operation became complete (ADR-0031); `null` while it isn't. */
  readonly completedAt: Millis | null;
}

export interface Carton {
  readonly id: string;
  readonly orderId: string;
  readonly product: string;
  readonly capacity: number;
  /** In placement order. */
  readonly members: readonly UnitKey[];
  readonly status: 'open' | 'closed';
  readonly closedAt: Millis | null;
}

/** `{orderId}-C{nn}`: at least two digits (`-C07`), more past 99 (`-C100`). */
export function cartonId(orderId: string, n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`carton number ${String(n)}`);
  }
  return `${orderId}-C${String(n).padStart(2, '0')}`;
}

const comparePacks = (a: Pack, b: Pack): number =>
  a.at - b.at || a.unit.epoch - b.unit.epoch || a.seq - b.seq || a.unit.partId - b.unit.partId;

/** Every order's cartons, by order (in the given order), then number. */
export function packCartons(
  orders: readonly OrderPacking[],
  packs: readonly Pack[],
  capacity: Readonly<Record<string, number>>,
): Carton[] {
  const byOrder = new Map<string, Pack[]>(orders.map((o) => [o.orderId, []]));
  for (const pack of packs) {
    const list = byOrder.get(pack.orderId);
    if (!list) {
      throw new RangeError(`unit ${unitId(pack.unit)} packed for unknown order ${pack.orderId}`);
    }
    list.push(pack);
  }
  return orders.flatMap((order) => {
    const size = capacity[order.product];
    if (size === undefined || !Number.isSafeInteger(size) || size < 1) {
      throw new RangeError(`no carton capacity for product ${order.product}`);
    }
    const sorted = [...(byOrder.get(order.orderId) ?? [])].sort(comparePacks);
    const cartons: Carton[] = [];
    let members: Pack[] = [];
    const emit = (closedAt: Millis | null): void => {
      cartons.push({
        id: cartonId(order.orderId, cartons.length + 1),
        orderId: order.orderId,
        product: order.product,
        capacity: size,
        members: members.map((p) => p.unit),
        status: closedAt === null ? 'open' : 'closed',
        closedAt,
      });
      members = [];
    };
    for (const pack of sorted) {
      members.push(pack);
      if (members.length === size) emit(pack.at);
    }
    if (members.length > 0) emit(order.completedAt);
    return cartons;
  });
}
