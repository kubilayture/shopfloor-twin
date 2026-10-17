/**
 * The plan's dispatch rule (#172, implemented in the MES by #174), restated for the golden tests:
 * released orders in planned-start order, ties by order number, each whole order to the CNC whose
 * queue with it appended finishes first by ideal time (NotBefore waits and changeovers counted,
 * `none→…` included); ties go to the lower id.
 */
const MINUTE = 60_000;

export interface ErpOrder {
  readonly orderNumber: string;
  readonly revision: number;
  readonly product: string;
  readonly quantity: number;
  readonly plannedStart: string;
}

interface Job {
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: number;
}

/** The dispatches the rule makes of a dataset's released orders (their latest revisions). */
export function dispatchRule(orders: readonly ErpOrder[], release: readonly string[]) {
  const latest = new Map<string, ErpOrder>();
  for (const order of orders) {
    latest.set(order.orderNumber, order);
  }
  const released = [...latest.values()]
    .filter((order) => release.includes(order.orderNumber))
    .sort(
      (a, b) =>
        Date.parse(a.plannedStart) - Date.parse(b.plannedStart) ||
        (a.orderNumber < b.orderNumber ? -1 : 1),
    );
  const ideal: Record<string, number> = { 'VB-100': 240_000, 'VB-200': 330_000 };
  const changeover = 25 * MINUTE;
  const queues = new Map<string, Job[]>([
    ['cnc-01', []],
    ['cnc-02', []],
  ]);
  const finish = (queue: readonly Job[]) => {
    let end = Number.NEGATIVE_INFINITY;
    let loaded: string | undefined;
    for (const job of queue) {
      const start = Math.max(job.notBefore, end) + (job.product === loaded ? 0 : changeover);
      end = start + job.quantity * (ideal[job.product] ?? 0);
      loaded = job.product;
    }
    return end;
  };
  return released.map((order) => {
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
      commandId: `${order.orderNumber}~OP10~1`,
      machine,
      orderId: order.orderNumber,
      product: order.product,
      quantity: order.quantity,
      notBefore: new Date(job.notBefore).toISOString(),
    };
  });
}
