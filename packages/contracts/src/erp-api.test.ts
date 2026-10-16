import { describe, expect, it } from 'vitest';
import {
  confirmationRequestSchema,
  expandErpDataset,
  idempotencyKeySchema,
  routingAndBom,
  statusMessageRequestSchema,
  type ErpMasterData,
} from './erp-api.ts';

const master: ErpMasterData = {
  operations: ['OP10', 'OP20', 'OP30'],
  componentsOperation: 'OP30',
  products: [
    { id: 'VB-100', blank: 'BLANK-100', components: ['SK-1'], reworkComponents: ['SK-1'] },
  ],
  workCenterByOperation: { OP10: 'cell-m1', OP20: 'cell-m1', OP30: 'line-a1' },
  lots: [{ id: 'L1', material: 'BLANK-100', quantity: 10 }],
};

const order = (orderNumber: string, revision: number, extra: object = {}) => ({
  orderNumber,
  revision,
  product: 'VB-100',
  quantity: 10,
  plannedStart: '2026-10-12T06:00:00+03:00',
  dueDate: '2026-10-12T14:00:00+03:00',
  ...extra,
});

describe('ERP dataset', () => {
  it('builds routing and BOM from master data, numbers the feed and normalises times to UTC', () => {
    const result = expandErpDataset({ orders: [order('A-1', 1), order('A-2', 1)] }, master);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.map((e) => e.feedSeq)).toEqual([1, 2]);
    const first = result.feed[0]?.order;
    expect(first).toMatchObject({
      priority: 5,
      status: 'open',
      plannedStart: '2026-10-12T03:00:00.000Z',
      dueDate: '2026-10-12T11:00:00.000Z',
    });
    expect(first?.routing).toEqual([
      { operation: 'OP10', workCenter: 'cell-m1' },
      { operation: 'OP20', workCenter: 'cell-m1' },
      { operation: 'OP30', workCenter: 'line-a1' },
    ]);
    expect(first?.bom).toEqual([
      { material: 'BLANK-100', operation: 'OP10', quantityPerUnit: 1, usage: 'standard' },
      { material: 'SK-1', operation: 'OP30', quantityPerUnit: 1, usage: 'standard' },
      { material: 'SK-1', operation: 'OP30', quantityPerUnit: 1, usage: 'rework' },
    ]);
    expect(result.lots).toEqual(master.lots);
  });

  it('keeps a routing and BOM the dataset gives, and its own lots', () => {
    const routing = [{ operation: 'OP10', workCenter: 'elsewhere' }];
    const lots = [{ id: 'X', material: 'Y', quantity: 1 }];
    const result = expandErpDataset(
      { orders: [order('A-1', 1, { routing, bom: [] })], lots },
      master,
    );
    expect(result.ok && result.feed[0]?.order).toMatchObject({ routing, bom: [] });
    expect(result.ok && result.lots).toEqual(lots);
  });

  it('gives an unknown product an empty routing and BOM, for the MES to reject', () => {
    const result = expandErpDataset({ orders: [order('A-1', 1, { product: 'VB-999' })] }, master);
    expect(result.ok && result.feed[0]?.order).toMatchObject({ routing: [], bom: [] });
  });

  it('refuses revisions that do not rise in feed order, and invalid entries', () => {
    const repeated = expandErpDataset({ orders: [order('A-1', 2), order('A-1', 2)] }, master);
    expect(repeated).toEqual({ ok: false, issues: ['orders.1: A-1 revision 2 after revision 2'] });
    const lower = expandErpDataset({ orders: [order('A-1', 2), order('A-1', 1)] }, master);
    expect(lower.ok).toBe(false);
    const bad = expandErpDataset({ orders: [order('A~1', 1)] }, master);
    expect(bad.ok || bad.issues[0]).toMatch(/^orders\.0\.orderNumber/);
    expect(expandErpDataset({ orders: [order('A-1', 1, { extra: 1 })] }, master).ok).toBe(false);
  });

  it('needs a work center for every operation', () => {
    expect(() => routingAndBom('VB-100', { ...master, workCenterByOperation: {} })).toThrow(
      'no work center runs OP10',
    );
  });
});

describe('ERP messages', () => {
  const confirmation = {
    orderNumber: 'A-1',
    revision: 1,
    operation: 'OP10',
    kind: 'final',
    confirmation: 1,
    yield: 9,
    scrap: [{ reason: 'DIMENSIONAL', quantity: 1 }],
    reworkPasses: 0,
    material: [{ material: 'BLANK-100', quantity: 10 }],
    confirmedAt: '2026-10-12T10:00:00+03:00',
  };

  it('numbers the final confirmation 1 and corrections from 2, with deltas only in corrections', () => {
    expect(confirmationRequestSchema.safeParse(confirmation).success).toBe(true);
    expect(confirmationRequestSchema.safeParse({ ...confirmation, confirmation: 2 }).success).toBe(
      false,
    );
    expect(confirmationRequestSchema.safeParse({ ...confirmation, yield: -1 }).success).toBe(false);
    const correction = { ...confirmation, kind: 'correction', confirmation: 2, yield: -1 };
    expect(confirmationRequestSchema.safeParse(correction).success).toBe(true);
    expect(confirmationRequestSchema.safeParse({ ...correction, confirmation: 1 }).success).toBe(
      false,
    );
  });

  it('allows `short` only on a completed status', () => {
    const status = { orderNumber: 'A-1', revision: 1, sentAt: '2026-10-12T10:00:00Z' };
    expect(
      statusMessageRequestSchema.safeParse({ ...status, status: 'completed', short: true }).success,
    ).toBe(true);
    expect(
      statusMessageRequestSchema.safeParse({ ...status, status: 'released', short: false }).success,
    ).toBe(false);
  });

  it('takes visible ASCII idempotency keys such as the MES builds', () => {
    expect(idempotencyKeySchema.safeParse('A-1~OP10~conf~1').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('A-1~status~accepted').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('has space').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('x'.repeat(201)).success).toBe(false);
  });
});
