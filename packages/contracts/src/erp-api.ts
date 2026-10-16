import { z } from 'zod';
import { problemSchema } from './mes-api.ts';

// The ERP mock's REST API (#171, ADR-0028), shared by `erp-mock`, which serves it, the MES's
// `orders` module, which pulls orders and posts confirmations and status messages, and the tests,
// whose golden harness serves a scenario's dataset through `expandErpDataset` without the app.

/** Limits of one request. */
export const ERP_API_LIMITS = {
  /** Feed entries per `GET /orders` page, by default and at most. */
  feedPage: 100,
  feedPageMax: 500,
  /** Most bytes in a request body. */
  bodyBytes: 64 * 1024,
  /** Characters of an `Idempotency-Key`. */
  idempotencyKey: 200,
  /** Characters of a status message's `reason`. */
  reason: 500,
  /** Scrap and material lines of one confirmation. */
  confirmationLines: 64,
} as const;

/**
 * Stable problem+json `type` URIs (RFC 9457) a client tells apart; every other problem is
 * `about:blank`. A 401 (no or wrong bearer token) is `about:blank` with `WWW-Authenticate: Bearer`.
 */
export const ERP_PROBLEM_TYPES = {
  /** 409: the `Idempotency-Key` was used before with another body. */
  idempotencyConflict: 'urn:shopfloor:erp-idempotency-conflict',
  /** 422: a message names an order, revision or operation the ERP doesn't hold. */
  unknownOrder: 'urn:shopfloor:erp-unknown-order',
  /** 409: `POST /orders` (dev only) with a revision not above the order's latest. */
  revisionConflict: 'urn:shopfloor:erp-revision-conflict',
  /** 422: the `Idempotency-Key` is not the key built from the body (`confirmationKey`, `statusKey`). */
  keyMismatch: 'urn:shopfloor:erp-key-mismatch',
  /**
   * 409: a confirmation with the order, operation and number of a stored one under another key.
   * The key check makes this unreachable through the API; the store refuses it anyway.
   */
  duplicateConfirmation: 'urn:shopfloor:erp-duplicate-confirmation',
  /** 422: a correction for an order operation with no final confirmation received. */
  correctionWithoutFinal: 'urn:shopfloor:erp-correction-without-final',
  /**
   * 409: `GET /orders?after=` beyond the feed's last entry: the cursor belongs to another feed
   * (compare `feedId`).
   */
  cursorAhead: 'urn:shopfloor:erp-cursor-ahead',
} as const;

/** Order number (no `~`: the MES builds idempotency keys from it with `~` as the separator). */
export const ERP_ORDER_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A scrap reason: a reason code id or its path in a tree (`DIMENSIONAL`, `SCRAP/LEAK`). */
const REASON = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}){0,7}$/;
/** Visible ASCII without spaces, as RFC 9110 tokens and the MES's `{order}~{operation}~conf~{n}`. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]+$/;

export const orderNumberSchema = z.string().regex(ERP_ORDER_NUMBER).describe('ERP order number');
/** The `Idempotency-Key` header every message post carries. */
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(ERP_API_LIMITS.idempotencyKey)
  .regex(IDEMPOTENCY_KEY, 'visible ASCII, no spaces');

/**
 * The `Idempotency-Key` of a confirmation: `{order}~{operation}~conf~{n}`, n = 1 for the final
 * confirmation and 2, 3, … for corrections. One key per (order, operation, n), so a confirmation
 * can't be stored twice under two keys.
 */
export const confirmationKey = (orderNumber: string, operation: string, confirmation: number) =>
  `${orderNumber}~${operation}~conf~${String(confirmation)}`;

/**
 * The `Idempotency-Key` of a status message: `{order}~r{revision}~status~{status}`. The revision is
 * part of it, so `accepted` for revision 1 and for revision 2 are two messages, not a conflict.
 */
export const statusKey = (orderNumber: string, revision: number, status: string) =>
  `${orderNumber}~r${String(revision)}~status~${status}`;
const idSchema = z.string().regex(ID);
const operationSchema = z
  .string()
  .regex(/^OP\d{2}$/)
  .describe('A routing operation, e.g. OP10');
/** A time the ERP stores: ISO 8601 with an offset; served in UTC with milliseconds. */
const timeInput = z.iso.datetime({ offset: true });
/** A message time: ISO 8601 with an offset, normalised to UTC, so one instant is one body. */
const messageTime = timeInput.transform((value) => new Date(value).toISOString());
const time = z.iso.datetime();
const int = z.number().int();
const count = int.min(0);

/** The ERP's own status of an order version; `cancelled` withdraws the order (a new revision). */
export const ERP_ORDER_STATUSES = ['open', 'cancelled'] as const;

/** What the MES reports about an order (plan "Order status feedback"). */
export const ORDER_STATUS_MESSAGES = [
  'accepted',
  'rejected',
  'rejected-revision',
  'released',
  'in-progress',
  'completed',
  'closed',
  'cancelled',
] as const;

export const BOM_USAGES = ['standard', 'rework'] as const;

export const routingStepSchema = z
  .strictObject({ operation: operationSchema, workCenter: idSchema })
  .describe('One routing operation and the work center that runs it');

export const bomItemSchema = z
  .strictObject({
    material: idSchema,
    operation: operationSchema,
    quantityPerUnit: int.min(1),
    usage: z
      .enum(BOM_USAGES)
      .describe('`standard`: every unit, first pass; `rework`: every rework pass of a unit'),
  })
  .describe('A material the operation consumes per unit');

const orderFields = {
  orderNumber: orderNumberSchema,
  revision: int.min(1).max(999),
  product: idSchema,
  quantity: int.min(1).max(100_000).describe('Units to produce'),
  priority: int.min(1).max(9).describe('1 most urgent'),
  status: z.enum(ERP_ORDER_STATUSES),
};

/** An order version as the feed serves it: routing and BOM always present (empty for an unknown product). */
export const erpOrderSchema = z
  .strictObject({
    ...orderFields,
    plannedStart: time.describe('Plant time the order may start, UTC'),
    dueDate: time.describe('Plant time the order is due, UTC'),
    routing: z.array(routingStepSchema),
    bom: z.array(bomItemSchema),
  })
  .describe('One revision of an ERP production order with its routing and BOM');

/**
 * An order version in a dataset file or the dev-only `POST /orders`: routing and BOM default to
 * the ones built from plant master data; a dataset may give its own (for a deliberately invalid order).
 */
export const erpOrderInputSchema = z.strictObject({
  ...orderFields,
  status: z.enum(ERP_ORDER_STATUSES).default('open'),
  priority: orderFields.priority.default(5),
  plannedStart: timeInput,
  dueDate: timeInput,
  routing: z.array(routingStepSchema).optional(),
  bom: z.array(bomItemSchema).optional(),
});

export const lotSchema = z
  .strictObject({ id: idSchema, material: idSchema, quantity: count })
  .describe('A material lot');

/** A dataset file (`config/erp/orders.yaml`, a scenario's `orders.json`): order versions in feed order. */
export const erpDatasetSchema = z.strictObject({
  orders: z.array(erpOrderInputSchema),
  /** Lot master data; defaults to the plant's `stock.yaml`. */
  lots: z.array(lotSchema).optional(),
});

export const feedEntrySchema = z.strictObject({
  feedSeq: int.min(1).describe('Position in the change feed; the cursor a client keeps'),
  order: erpOrderSchema,
});

export const orderFeedSchema = z
  .strictObject({
    feedId: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .describe(
        'Identity of this feed: a hash of the expanded dataset and of the store id created with the ' +
          'store. A client keeps it beside its cursor; when it changes, the cursor belongs to ' +
          'another feed (dataset replaced or store deleted) and the client raises an incident or ' +
          'resets its cursor to 0 (imports are idempotent by order number and revision).',
      ),
    entries: z.array(feedEntrySchema),
    cursor: count.describe('Pass as `after` for the next page: the last entry here, or `after`'),
    more: z.boolean().describe('More entries follow this page'),
  })
  .describe('`GET /api/v1/orders?after={cursor}&limit={n}`: order versions after the cursor');

export const lotListSchema = z.strictObject({ lots: z.array(lotSchema) });

const scrapLine = z.strictObject({ reason: z.string().regex(REASON), quantity: int });
const materialLine = z.strictObject({ material: idSchema, quantity: int });

/**
 * `POST /api/v1/confirmations`: the final confirmation of an order operation (`confirmation` 1,
 * counts ≥ 0) or a correction (`confirmation` ≥ 2, signed deltas against what was confirmed).
 */
export const confirmationRequestSchema = z
  .strictObject({
    orderNumber: orderNumberSchema,
    revision: int.min(1),
    operation: operationSchema,
    kind: z.enum(['final', 'correction']),
    confirmation: int.min(1).describe('n of the key `{order}~{operation}~conf~{n}`'),
    yield: int.describe('Good units'),
    scrap: z.array(scrapLine).max(ERP_API_LIMITS.confirmationLines),
    reworkPasses: int,
    material: z
      .array(materialLine)
      .max(ERP_API_LIMITS.confirmationLines)
      .describe('Backflushed material'),
    confirmedAt: messageTime.describe('Plant time the operation was confirmed; served in UTC'),
  })
  .superRefine((value, ctx) => {
    if ((value.kind === 'final') !== (value.confirmation === 1)) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmation'],
        message: 'the final confirmation is number 1, corrections are 2 and above',
      });
    }
    if (value.kind === 'final') {
      const negative =
        value.yield < 0 ||
        value.reworkPasses < 0 ||
        value.scrap.some((line) => line.quantity < 0) ||
        value.material.some((line) => line.quantity < 0);
      if (negative) {
        ctx.addIssue({ code: 'custom', message: 'a final confirmation has no negative counts' });
      }
    }
  });

/** `POST /api/v1/order-status`: a status message about an order. */
export const statusMessageRequestSchema = z
  .strictObject({
    orderNumber: orderNumberSchema,
    revision: int.min(1),
    status: z.enum(ORDER_STATUS_MESSAGES),
    short: z.boolean().optional().describe('Only with `completed`: packed good < quantity'),
    reason: z.string().min(1).max(ERP_API_LIMITS.reason).optional(),
    sentAt: messageTime.describe('Plant time of the status change; served in UTC'),
  })
  .superRefine((value, ctx) => {
    if (value.short !== undefined && value.status !== 'completed') {
      ctx.addIssue({ code: 'custom', path: ['short'], message: 'only with status completed' });
    }
  });

export const MESSAGE_KINDS = ['confirmation', 'status'] as const;

/** The answer to a message post: 201 the first time, 200 with the same receipt on a replay. */
export const messageReceiptSchema = z.strictObject({
  idempotencyKey: z.string(),
  kind: z.enum(MESSAGE_KINDS),
  orderNumber: orderNumberSchema,
  receivedSeq: int.min(1).describe('Order in which the ERP received its messages'),
  receivedAt: time.describe('Wall time of the first receipt'),
});

export const confirmationListSchema = z.strictObject({
  confirmations: z.array(
    z.strictObject({ receipt: messageReceiptSchema, body: confirmationRequestSchema }),
  ),
});

export const statusMessageListSchema = z.strictObject({
  messages: z.array(
    z.strictObject({ receipt: messageReceiptSchema, body: statusMessageRequestSchema }),
  ),
});

export const operationTotalsSchema = z.strictObject({
  operation: operationSchema,
  workCenter: z.string(),
  confirmations: count.describe('Messages received: the final one plus corrections'),
  yield: int,
  scrap: z.array(scrapLine),
  scrapTotal: int,
  reworkPasses: int,
  material: z.array(materialLine),
});

/** `GET /api/v1/orders/{orderNumber}`: the ERP's view of an order, derived from what the MES sent. */
export const erpOrderViewSchema = z.strictObject({
  order: erpOrderSchema.describe('Its latest revision'),
  revisions: z.array(int.min(1)),
  status: z
    .enum(ORDER_STATUS_MESSAGES)
    .nullable()
    .describe(
      'The status of the last status message received (highest `receivedSeq`), whatever its ' +
        'place in the lifecycle; null before any. The ERP takes the MES at its word: a late ' +
        '`released` after `completed` makes the status `released`.',
    ),
  short: z.boolean(),
  statusHistory: z.array(
    z.strictObject({
      status: z.enum(ORDER_STATUS_MESSAGES),
      revision: int.min(1),
      receivedSeq: int.min(1),
      receivedAt: time,
    }),
  ),
  operations: z
    .array(operationTotalsSchema)
    .describe('Per routing operation of the latest revision'),
});

export const erpProblemSchema = problemSchema;

export type ErpOrder = z.infer<typeof erpOrderSchema>;
export type ErpOrderInput = z.input<typeof erpOrderInputSchema>;
/** An input order version after parsing: defaults applied. */
export type ParsedErpOrderInput = z.output<typeof erpOrderInputSchema>;
export type ErpDataset = z.input<typeof erpDatasetSchema>;
export type RoutingStep = z.infer<typeof routingStepSchema>;
export type BomItem = z.infer<typeof bomItemSchema>;
export type Lot = z.infer<typeof lotSchema>;
export type FeedEntry = z.infer<typeof feedEntrySchema>;
export type OrderFeed = z.infer<typeof orderFeedSchema>;
export type LotList = z.infer<typeof lotListSchema>;
export type ConfirmationRequest = z.infer<typeof confirmationRequestSchema>;
export type StatusMessageRequest = z.infer<typeof statusMessageRequestSchema>;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type MessageReceipt = z.infer<typeof messageReceiptSchema>;
export type ConfirmationList = z.infer<typeof confirmationListSchema>;
export type StatusMessageList = z.infer<typeof statusMessageListSchema>;
export type OperationTotals = z.infer<typeof operationTotalsSchema>;
export type ErpOrderView = z.infer<typeof erpOrderViewSchema>;
export type OrderStatusMessage = (typeof ORDER_STATUS_MESSAGES)[number];

/** What the ERP builds routings and BOMs from: a view of the plant's `products.yaml` and `plant.yaml`. */
export interface ErpMasterData {
  /** Routing operations in order (`products.yaml` `operations`). */
  readonly operations: readonly string[];
  /** The operation that consumes the components (`componentsOperation`). */
  readonly componentsOperation: string;
  /** Products; the blank is consumed at the first operation, components at `componentsOperation`. */
  readonly products: readonly {
    readonly id: string;
    readonly blank: string;
    readonly components: readonly string[];
    readonly reworkComponents: readonly string[];
  }[];
  /** The work center of each operation (from the equipment that runs it). */
  readonly workCenterByOperation: Readonly<Record<string, string>>;
  /** The plant's lots (`stock.yaml`), used when the dataset has none. */
  readonly lots: readonly Lot[];
}

/** The routing and BOM of a product from master data; empty for an unknown product. */
export function routingAndBom(
  product: string,
  master: ErpMasterData,
): { routing: RoutingStep[]; bom: BomItem[] } {
  const spec = master.products.find((p) => p.id === product);
  const first = master.operations[0];
  if (spec === undefined || first === undefined) return { routing: [], bom: [] };
  const routing = master.operations.map((operation) => {
    const workCenter = master.workCenterByOperation[operation];
    if (workCenter === undefined) throw new Error(`no work center runs ${operation}`);
    return { operation, workCenter };
  });
  const item = (material: string, operation: string, usage: BomItem['usage']): BomItem => ({
    material,
    operation,
    quantityPerUnit: 1,
    usage,
  });
  const bom = [
    item(spec.blank, first, 'standard'),
    ...spec.components.map((m) => item(m, master.componentsOperation, 'standard')),
    ...spec.reworkComponents.map((m) => item(m, master.componentsOperation, 'rework')),
  ];
  return { routing, bom };
}

export type DatasetResult =
  | { readonly ok: true; readonly feed: FeedEntry[]; readonly lots: Lot[] }
  | { readonly ok: false; readonly issues: string[] };

/**
 * A dataset as the feed serves it (deterministic: feed numbers are positions, times normalised to
 * UTC). Checks that each (order number, revision) is unique and that an order's revisions rise in
 * feed order, as an ERP only ever issues a newer revision.
 */
export function expandErpDataset(raw: unknown, master: ErpMasterData): DatasetResult {
  const parsed = erpDatasetSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }
  const issues: string[] = [];
  const latest = new Map<string, number>();
  const feed: FeedEntry[] = [];
  parsed.data.orders.forEach((input, index) => {
    const before = latest.get(input.orderNumber);
    if (before !== undefined && input.revision <= before) {
      issues.push(
        `orders.${String(index)}: ${input.orderNumber} revision ${String(input.revision)} after revision ${String(before)}`,
      );
    }
    latest.set(input.orderNumber, Math.max(before ?? 0, input.revision));
    feed.push({ feedSeq: index + 1, order: toErpOrder(input, master) });
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, feed, lots: parsed.data.lots ?? [...master.lots] };
}

/** An input order version completed from master data (routing and BOM unless given), times in UTC. */
export function toErpOrder(input: ParsedErpOrderInput, master: ErpMasterData): ErpOrder {
  const derived = routingAndBom(input.product, master);
  return {
    orderNumber: input.orderNumber,
    revision: input.revision,
    product: input.product,
    quantity: input.quantity,
    priority: input.priority,
    status: input.status,
    plannedStart: new Date(input.plannedStart).toISOString(),
    dueDate: new Date(input.dueDate).toISOString(),
    routing: input.routing ?? derived.routing,
    bom: input.bom ?? derived.bom,
  };
}
