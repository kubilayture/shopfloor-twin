import { terminalViewSchema } from '@shopfloor/contracts/mes-api';
import { describe, expect, it } from 'vitest';
import type { EquipmentInfo } from '../master-data/index.ts';
import type { HoldRecord, SignalRecord } from '../quality/index.ts';
import { terminalView, type TerminalViewSources } from './terminal-view.ts';

// The terminal's quality part (#203): open holds touching the work center's orders, the episodes
// of its machines that are open or unacknowledged, and the lots of each machine's last cycle.

const T0 = Date.parse('2026-10-12T06:00:00.000Z');

const machine = (id: string, operation: string, workCenter: string, position: number) =>
  ({
    id,
    name: id.toUpperCase(),
    operation,
    interface: 'opcua',
    position,
    site: { id: 'izmir', name: 'Izmir' },
    area: { id: 'assembly', name: 'Assembly' },
    workCenter: { id: workCenter, name: workCenter },
  }) satisfies EquipmentInfo;

const CATALOG = new Map(
  [
    machine('asm-01', 'OP30', 'line-a1', 1),
    machine('lkt-01', 'OP40', 'line-a1', 2),
    machine('cnc-01', 'OP10', 'cell-m1', 1),
  ].map((m) => [m.id, m]),
);

const ref = (partId: number, minutes: number) => ({
  epoch: 1,
  partId,
  pass: 1,
  at: T0 + minutes * 60_000,
  seq: partId,
});

function signal(id: number, overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id,
    characteristic: 'leak-rate',
    version: 1,
    chart: 'I',
    rule: 1,
    first: ref(id, id),
    last: ref(id, id),
    points: 1,
    closedBy: null,
    baseline: false,
    extentFinal: false,
    status: 'provisional',
    detectedAt: new Date(T0),
    detectedPlantAt: null,
    finalAt: null,
    withdrawnAt: null,
    withdrawnReason: null,
    acknowledged: null,
    rowVersion: 1,
    ...overrides,
  };
}

const HOLD: HoldRecord = {
  id: '11111111-2222-4333-8444-555555555555',
  subject: { kind: 'lot', id: 'K1' },
  state: 'open',
  reason: 'SUSPECT-LOT',
  openedBy: 'quinn',
  openedAt: new Date(T0),
  openedPlantAt: new Date(T0),
  decidedBy: null,
  decidedAt: null,
  decidedPlantAt: null,
  decisionReason: null,
  transitions: 1,
  version: 1,
  scope: { units: 2, cartons: 1, orders: 1 },
  heldMaterialConsumed: 0,
};

function sources(extra: Partial<TerminalViewSources> = {}): TerminalViewSources {
  return {
    equipment: { currentStates: () => [] },
    orders: {
      list: () => Promise.resolve({ orders: [], truncated: false }),
      operations: () => Promise.resolve([]),
      commands: () => Promise.resolve([]),
    },
    ...extra,
  };
}

describe('the terminal view’s quality part (#203)', () => {
  it('is empty without the quality modules', async () => {
    const view = await terminalView(sources(), { id: 'line-a1', name: 'Line A1' }, CATALOG);
    expect(view.quality).toEqual({ holds: [], signals: [], lots: [], truncated: false });
    expect(terminalViewSchema.parse(view).quality.signals).toEqual([]);
  });

  it('shows open holds, open or unacknowledged episodes of its machines, and the last lots', async () => {
    const asked: string[] = [];
    const ack = { by: 'quinn', at: new Date(T0), plantAt: null, comment: 'seen' };
    const view = await terminalView(
      sources({
        holds: {
          openOnOrders: (ids, limit) => {
            expect(limit).toBe(10);
            expect(ids).toEqual([]);
            return Promise.resolve({ holds: [{ hold: HOLD, orders: ['X-1'] }], truncated: false });
          },
        },
        quality: {
          machines: () => [
            { characteristic: 'leak-rate', equipment: 'lkt-01' },
            { characteristic: 'torque', equipment: 'cnc-01' },
          ],
          signals: (query) => {
            asked.push(query?.characteristic ?? '');
            return Promise.resolve({
              signals: [
                signal(5),
                signal(4, { closedBy: ref(5, 5) }), // closed, unacknowledged: shown
                signal(3, { closedBy: ref(4, 4), acknowledged: ack }), // closed and seen: not
                signal(2, { acknowledged: ack, status: 'final' }), // open, acknowledged: shown
                signal(1, { baseline: true }), // baseline: not
              ],
              truncated: false,
            });
          },
        },
        genealogy: {
          lastLots: (equipment) => {
            expect(equipment).toEqual(['asm-01', 'lkt-01']);
            return Promise.resolve([
              {
                equipment: 'asm-01',
                operation: 'OP30',
                epoch: 1,
                partId: 7,
                serial: 'VB-7',
                pass: 1,
                at: new Date(T0),
                lots: [{ lot: 'K1', material: 'SK-1' }],
              },
              {
                equipment: 'lkt-01',
                operation: 'OP40',
                epoch: 1,
                partId: 7,
                serial: null,
                pass: 1,
                at: new Date(T0),
                lots: [],
              },
            ]);
          },
        },
      }),
      { id: 'line-a1', name: 'Line A1' },
      CATALOG,
    );
    const parsed = terminalViewSchema.parse(view);
    expect(asked).toEqual(['leak-rate']);
    expect(parsed.quality.holds.map((h) => [h.hold.id, h.orders])).toEqual([[HOLD.id, ['X-1']]]);
    expect(parsed.quality.signals.map((s) => s.id)).toEqual([5, 4, 2]);
    expect(parsed.quality.lots).toEqual([
      {
        equipment: 'asm-01',
        operation: 'OP30',
        epoch: 1,
        partId: 7,
        serial: 'VB-7',
        pass: 1,
        at: '2026-10-12T06:00:00.000Z',
        lots: [{ lot: 'K1', material: 'SK-1' }],
      },
    ]);
    expect(parsed.quality.truncated).toBe(false);
  });

  it('says when more holds or episodes exist than it shows', async () => {
    const view = await terminalView(
      sources({
        holds: {
          openOnOrders: () => Promise.resolve({ holds: [], truncated: true }),
        },
        quality: {
          machines: () => [{ characteristic: 'leak-rate', equipment: 'lkt-01' }],
          signals: () =>
            Promise.resolve({
              signals: Array.from({ length: 12 }, (_, i) => signal(i + 1)),
              truncated: false,
            }),
        },
      }),
      { id: 'line-a1', name: 'Line A1' },
      CATALOG,
    );
    expect(view.quality.truncated).toBe(true);
    expect(view.quality.signals.map((s) => s.id)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });
});
