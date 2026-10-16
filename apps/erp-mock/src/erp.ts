import {
  toErpOrder,
  type ConfirmationRequest,
  type ErpMasterData,
  type ErpOrder,
  type ErpOrderView,
  type FeedEntry,
  type Lot,
  type OperationTotals,
  type OrderFeed,
  type ParsedErpOrderInput,
  type StatusMessageRequest,
} from '@shopfloor/contracts/erp-api';
import type { Dataset } from './dataset.ts';
import type { ErpStore } from './store.ts';

export type AddOrderResult =
  | { readonly ok: true; readonly entry: FeedEntry }
  | { readonly ok: false; readonly latest: number };

const sum = (lines: Iterable<readonly [string, number]>): { key: string; quantity: number }[] => {
  const totals = new Map<string, number>();
  for (const [key, quantity] of lines) totals.set(key, (totals.get(key) ?? 0) + quantity);
  return [...totals]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, quantity]) => ({ key, quantity }));
};

/**
 * The ERP mock's state (ADR-0028): the change feed (the dataset's order versions, then those added
 * through the dev-only `POST /orders`), the lots, and the messages the MES sent, from which it
 * derives its own view of each order.
 */
export class Erp {
  readonly #feed: FeedEntry[];
  readonly #lots: readonly Lot[];
  readonly #master: ErpMasterData;
  readonly #store: ErpStore;

  constructor(dataset: Dataset, store: ErpStore) {
    const added = store.adminOrders();
    // Feed numbers must stay dense and stable: added orders follow the dataset's last entry.
    const misplaced = added.find((entry, i) => entry.feedSeq !== dataset.feed.length + i + 1);
    if (misplaced !== undefined) {
      throw new Error(
        `the store holds an order added at feed number ${String(misplaced.feedSeq)}, but the dataset ` +
          `now has ${String(dataset.feed.length)} entries: it changed under the added orders; delete the store`,
      );
    }
    this.#feed = [...dataset.feed, ...added];
    this.#lots = dataset.lots;
    this.#master = dataset.master;
    this.#store = store;
  }

  get feedLength(): number {
    return this.#feed.length;
  }

  get lots(): readonly Lot[] {
    return this.#lots;
  }

  /** Order versions after the cursor, in feed order. */
  feedPage(after: number, limit: number): OrderFeed {
    // Feed numbers are dense from 1, so the entry after `after` sits at index `after`.
    const entries = this.#feed.slice(after, after + limit);
    const last = entries.at(-1);
    return {
      entries,
      cursor: last?.feedSeq ?? after,
      more: (last?.feedSeq ?? after) < this.#feed.length,
    };
  }

  /** Every revision of an order, in feed order (rising). */
  revisions(orderNumber: string): ErpOrder[] {
    return this.#feed.filter((e) => e.order.orderNumber === orderNumber).map((e) => e.order);
  }

  revision(orderNumber: string, revision: number): ErpOrder | undefined {
    return this.revisions(orderNumber).find((order) => order.revision === revision);
  }

  /** Adds an order version at the end of the feed; refused unless its revision is the order's newest. */
  addOrder(input: ParsedErpOrderInput, now: Date): AddOrderResult {
    const latest = this.revisions(input.orderNumber).at(-1)?.revision ?? 0;
    if (input.revision <= latest) return { ok: false, latest };
    const entry: FeedEntry = {
      feedSeq: this.#feed.length + 1,
      order: toErpOrder(input, this.#master),
    };
    this.#store.addAdminOrder(entry, now);
    this.#feed.push(entry);
    return { ok: true, entry };
  }

  /**
   * A message names an order the ERP holds: the order and revision exist and, for a confirmation,
   * the operation is on that revision's routing. Returns why not, or undefined.
   */
  unknownReference(body: ConfirmationRequest | StatusMessageRequest): string | undefined {
    const order = this.revision(body.orderNumber, body.revision);
    if (order === undefined) {
      return this.revisions(body.orderNumber).length === 0
        ? `order ${body.orderNumber} is unknown`
        : `order ${body.orderNumber} has no revision ${String(body.revision)}`;
    }
    if ('operation' in body && !order.routing.some((s) => s.operation === body.operation)) {
      return `order ${body.orderNumber} revision ${String(body.revision)} has no operation ${body.operation}`;
    }
    return undefined;
  }

  /** The ERP's view of an order: its latest revision, the status messages and the confirmed totals. */
  view(orderNumber: string): ErpOrderView | undefined {
    const revisions = this.revisions(orderNumber);
    const order = revisions.at(-1);
    if (order === undefined) return undefined;
    const statuses = this.#store.messages('status', orderNumber).map(({ receipt, body }) => ({
      receipt,
      body: body as StatusMessageRequest,
    }));
    const confirmations = this.#store
      .messages('confirmation', orderNumber)
      .map(({ body }) => body as ConfirmationRequest);
    const lastCompleted = statuses.findLast((m) => m.body.status === 'completed');
    const operations = order.routing.map(({ operation, workCenter }): OperationTotals => {
      const mine = confirmations.filter((c) => c.operation === operation);
      const scrap = sum(mine.flatMap((c) => c.scrap.map((l) => [l.reason, l.quantity] as const)));
      return {
        operation,
        workCenter,
        confirmations: mine.length,
        yield: mine.reduce((total, c) => total + c.yield, 0),
        scrap: scrap.map(({ key, quantity }) => ({ reason: key, quantity })),
        scrapTotal: scrap.reduce((total, l) => total + l.quantity, 0),
        reworkPasses: mine.reduce((total, c) => total + c.reworkPasses, 0),
        material: sum(
          mine.flatMap((c) => c.material.map((l) => [l.material, l.quantity] as const)),
        ).map(({ key, quantity }) => ({ material: key, quantity })),
      };
    });
    return {
      order,
      revisions: revisions.map((r) => r.revision),
      status: statuses.at(-1)?.body.status ?? null,
      short: lastCompleted?.body.short ?? false,
      statusHistory: statuses.map(({ receipt, body }) => ({
        status: body.status,
        revision: body.revision,
        receivedSeq: receipt.receivedSeq,
        receivedAt: receipt.receivedAt,
      })),
      operations,
    };
  }
}
