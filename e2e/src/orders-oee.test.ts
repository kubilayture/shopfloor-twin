import type { LineBucketDto, OrderOeeDto } from '@shopfloor/contracts/mes-api';
import { describe, expect, it } from 'vitest';
import {
  SHIFT_A_COMPLETED,
  checkOeeScreen,
  checkOrderOee,
  type LineOeeTruth,
  type OeeExpected,
  type PassContext,
} from './orders-pass.ts';

const ratio = (fraction: string, decimal: string) => ({ fraction, decimal });
const HOUR = 3_600_000;
const FROM = Date.parse('2026-10-12T03:00:00.000Z');
const TO = FROM + 8 * HOUR;
const SHIFT = '2026-10-12/A';
const iso = (t: number) => new Date(t).toISOString();

const result = {
  availability: ratio('4/5', '0.8000'),
  performance: ratio('7/8', '0.8750'),
  quality: ratio('9/10', '0.9000'),
  oee: ratio('63/100', '0.6300'),
  anomaly: false,
  provisional: false,
  totals: {
    plannedBusyMs: 1_000_000,
    actualProductionMs: 800_000,
    excludedMs: 0,
    longStopMs: 0,
    microStopMs: 40_000,
    idealMs: 700_000,
    good: 9,
    scrap: 1,
    rework: 0,
    produced: 10,
  },
  unplanned: { good: 0, produced: 0, idealMs: 0 },
  losses: null,
};

const lineValue = (from: number, to: number, aboveOne = false) => ({
  from: iso(from),
  to: iso(to),
  plannedBusyMs: to - from,
  good: { 'VB-100': 10 },
  idealMs: '1500000/1',
  oee: aboveOne ? ratio('21/20', '1.0500') : ratio('3/4', '0.7500'),
  aboveOne,
  provisional: false,
});

/** A truth of `count` orders completed in shift A (and one still open), 8 hours, the shift. */
function truthOf(count: number): LineOeeTruth {
  const orders: LineOeeTruth['orders'] = {};
  for (let i = 1; i <= count + 1; i++) {
    const id = `PO-${String(i)}`;
    const open = i > count;
    const start = FROM + (i - 1) * 600_000;
    orders[id] = {
      product: 'VB-100',
      jobs: [`${id}~OP10~1`],
      jobOee: {
        [`${id}~OP10~1`]: {
          machine: 'cnc-01',
          headTime: iso(start),
          headSource: 'accepted',
          window: { from: iso(start), to: iso(start + HOUR), open },
          cycles: 10,
          oee: result,
        },
      },
      oee: result,
      open,
      pending: false,
      headTimeUnknown: false,
      endLost: false,
      lost: false,
      firstPassYield: { firstPassGood: 9, started: 10, yield: ratio('9/10', '0.9000') },
      completedAt: open ? null : iso(start + 2 * HOUR),
      line: { ...lineValue(start, start + 2 * HOUR, i === 1), provisional: open },
    };
  }
  const hours: LineOeeTruth['line']['hours'] = {};
  for (let h = 0; h < 8; h++)
    hours[iso(FROM + h * HOUR)] = lineValue(FROM + h * HOUR, FROM + (h + 1) * HOUR);
  return {
    config: { productionMode: 'orders' },
    bottlenecks: {
      'VB-100': {
        operation: 'OP30',
        equipment: ['asm-01'],
        idealCycleMs: 150_000,
        effectiveCycleMs: '150000/1',
      },
    },
    line: { hours, shifts: { [SHIFT]: lineValue(FROM, TO) } },
    orders,
  };
}

/** The MES's answer for a truth order, as `GET /oee/orders/{id}` gives it once final. */
function dtoOf(id: string, t: LineOeeTruth['orders'][string]): OrderOeeDto {
  const line = t.line;
  return {
    orderId: id,
    product: t.product,
    status: t.completedAt === null ? 'in-progress' : 'completed',
    oee: t.oee as OrderOeeDto['oee'],
    open: t.open,
    pending: t.pending,
    headTimeUnknown: t.headTimeUnknown,
    endLost: t.endLost,
    lost: t.lost,
    final: true,
    jobs: t.jobs.map((commandId) => {
      const job = t.jobOee[commandId] as unknown as {
        machine: string;
        headTime: string;
        window: { from: string; to: string; open: boolean };
        cycles: number;
      };
      return {
        commandId,
        machine: job.machine,
        deviceEpoch: 1,
        quantity: 10,
        notBefore: job.headTime,
        head: {
          kind: 'head' as const,
          at: job.headTime,
          source: 'accepted' as const,
          reason: null,
        },
        window: { ...job.window, headTimeUnknown: false, endLost: false, lost: false },
        cycles: job.cycles,
        oee: result,
        final: true,
      };
    }),
    firstPassYield: { ...t.firstPassYield, final: true },
    completedAt: t.completedAt,
    cutoffs: [],
    incidents: [],
    mayRevise: false,
    revision: 0,
    line: line && {
      from: line.from,
      to: line.to,
      through: line.to,
      plannedBusyMs: line.plannedBusyMs,
      good: line.good,
      idealMs: line.idealMs,
      oee: line.oee,
      aboveOne: line.aboveOne,
      open: t.completedAt === null,
      final: true,
    },
  };
}

const bucketOf = (
  bucket: 'hour' | 'shift',
  key: string,
  value: LineOeeTruth['line']['hours'][string],
) =>
  ({
    bucket,
    key,
    from: value.from,
    to: value.to,
    through: value.to,
    plannedBusyMs: value.plannedBusyMs,
    good: value.good,
    idealMs: value.idealMs,
    oee: value.oee,
    aboveOne: value.aboveOne,
    final: true,
    incidents: [],
    mayRevise: false,
    revision: 0,
  }) satisfies LineBucketDto;

/** A context whose simulator serves `live` and whose MES answers from `mes` (the truth by default). */
function contextOf(live: LineOeeTruth, change: (dto: OrderOeeDto) => OrderOeeDto = (d) => d) {
  const failures: string[] = [];
  const ctx = {
    fail: (m: string) => failures.push(m),
    log: () => undefined,
    sim: {
      groundTruthJson: (asOf: string) => Promise.resolve({ lineOeeAsOf: asOf, lineOee: live }),
    },
    mes: {
      orderOee: (id: string) => {
        const t = live.orders[id];
        if (!t) throw new Error(`no ${id}`);
        return Promise.resolve(change(dtoOf(id, t)));
      },
      orders: () =>
        Promise.resolve({
          orders: Object.entries(live.orders).map(([id, o]) => ({
            id,
            completedAt: o.completedAt,
          })),
        }),
      lineOee: (bucket: 'hour' | 'shift') =>
        Promise.resolve({
          productionMode: 'orders',
          bottlenecks: [
            {
              product: 'VB-100',
              operation: 'OP30',
              equipment: ['asm-01'],
              idealCycleMs: 150_000,
              effectiveCycleMs: '150000/1',
            },
          ],
          buckets:
            bucket === 'shift'
              ? [bucketOf('shift', SHIFT, live.line.shifts[SHIFT] ?? lineValue(FROM, TO))]
              : Object.entries(live.line.hours).map(([key, value]) => bucketOf('hour', key, value)),
        }),
    },
  } as unknown as PassContext;
  return { ctx, failures };
}

const cut = { from: FROM, to: TO, shiftKey: SHIFT };

describe('checkOrderOee (#233)', () => {
  it('passes when 5 orders complete and the MES equals the truth and the golden', async () => {
    const truth = truthOf(SHIFT_A_COMPLETED);
    const { ctx, failures } = contextOf(truth);
    const { report, expected } = await checkOrderOee(ctx, cut, truthOf(SHIFT_A_COMPLETED));
    expect(failures).toEqual([]);
    expect(report.completed).toHaveLength(SHIFT_A_COMPLETED);
    expect(report.mesCompleted).toEqual(report.completed);
    expect(Object.keys(expected.orders)).toHaveLength(SHIFT_A_COMPLETED);
    expect(expected.orders['PO-1']).toMatchObject({
      lineAboveOne: true,
      jobs: [{ id: 'PO-1~OP10~1', oee: '0.6300' }],
    });
    expect(report.line).toMatchObject({ final: true, equal: true, hours: 8 });
  });

  it('fails with 4 completed orders, even when the golden agrees', async () => {
    const { ctx, failures } = contextOf(truthOf(4));
    await checkOrderOee(ctx, cut, truthOf(4));
    expect(failures.some((f) => f.includes('not exactly 5'))).toBe(true);
  });

  it('fails when an MES value differs from the truth', async () => {
    const { ctx, failures } = contextOf(truthOf(5), (dto) =>
      dto.orderId === 'PO-3'
        ? { ...dto, oee: { ...dto.oee, oee: ratio('64/100', '0.6400') } }
        : dto,
    );
    await checkOrderOee(ctx, cut, truthOf(5));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('PO-3 order OEE');
    expect(failures[0]).toContain('MES: order: .oee.oee.decimal');
  });

  it('fails when the order’s line value differs', async () => {
    const { ctx, failures } = contextOf(truthOf(5), (dto) =>
      dto.orderId === 'PO-2' && dto.line
        ? { ...dto, line: { ...dto.line, plannedBusyMs: 1 } }
        : dto,
    );
    await checkOrderOee(ctx, cut, truthOf(5));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('MES: line: .plannedBusyMs');
  });

  it('fails when the live truth differs from the golden', async () => {
    const golden = truthOf(5);
    const changed = golden.orders['PO-4'];
    if (!changed) throw new Error('no PO-4');
    golden.orders['PO-4'] = {
      ...changed,
      firstPassYield: { ...changed.firstPassYield, started: 11 },
    };
    const { ctx, failures } = contextOf(truthOf(5));
    await checkOrderOee(ctx, cut, golden);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('golden: .firstPassYield.started');
  });

  it('fails when the MES completed another set before the cut', async () => {
    const truth = truthOf(5);
    const { ctx, failures } = contextOf(truth);
    const mes = (ctx as unknown as { mes: { orders: () => Promise<unknown> } }).mes;
    mes.orders = () =>
      Promise.resolve({
        orders: Object.keys(truth.orders).map((id) => ({
          id,
          completedAt: id === 'PO-6' ? iso(FROM + HOUR) : (truth.orders[id]?.completedAt ?? null),
        })),
      });
    await checkOrderOee(ctx, cut, truthOf(5));
    expect(failures.some((f) => f.startsWith('orders the MES completed in shift A'))).toBe(true);
  });
});

const ids = Array.from({ length: SHIFT_A_COMPLETED }, (_, i) => `PO-2610-00${String(i + 1)}`);

const expected: OeeExpected = {
  orders: Object.fromEntries(
    ids.map((id) => [
      id,
      {
        oee: result,
        firstPassYield: { firstPassGood: 9, started: 10, yield: ratio('9/10', '0.9000') },
        line: ratio('3/16', '0.1875'),
        lineAboveOne: false,
        jobs: [{ id: `${id}~OP10~1`, oee: '0.6300' }],
      },
    ]),
  ),
  shiftKey: SHIFT,
  line: ratio('21/20', '1.0500'),
  lineAboveOne: true,
  bottlenecks: {
    'VB-100': {
      operation: 'OP30',
      equipment: ['asm-01'],
      idealCycleMs: 150_000,
      effectiveCycleMs: '150000/1',
    },
  },
};

/** What the page shows when it equals `expected`. */
function screen() {
  const order = (id: string) => ({
    final: 'true',
    incidents: '0',
    revision: '0',
    oee: ratio('63/100', '0.6300'),
    availability: ratio('4/5', '0.8000'),
    performance: ratio('7/8', '0.8750'),
    quality: ratio('9/10', '0.9000'),
    firstPassYield: {
      final: 'true',
      yield: ratio('9/10', '0.9000'),
      firstPassGood: 9,
      started: 10,
    },
    line: { final: 'true', aboveOne: 'false', oee: ratio('3/16', '0.1875') },
    jobs: [{ id: `${id}~OP10~1`, oee: '0.6300', final: 'true' }],
  });
  return {
    orders: Object.fromEntries(ids.map((id) => [id, order(id)])),
    line: {
      key: SHIFT,
      final: 'true',
      aboveOne: 'true',
      oee: ratio('21/20', '1.0500'),
      bottlenecks: [{ product: 'VB-100', operation: 'OP30', equipment: 'asm-01' }],
      workCenterBottleneck: [{ id: 'bottleneck-line-a1', equipment: 'asm-01' }],
    },
  };
}

function screenContext() {
  const failures: string[] = [];
  const ctx = { fail: (m: string) => failures.push(m) } as unknown as PassContext;
  return { ctx, failures };
}

describe('checkOeeScreen (#233)', () => {
  it('passes when the page shows the truth’s values for exactly the expected orders', () => {
    const { ctx, failures } = screenContext();
    const result = checkOeeScreen(ctx, screen(), expected);
    expect(failures).toEqual([]);
    expect(result).toMatchObject({ orders: SHIFT_A_COMPLETED, equal: true, line: '1.0500' });
  });

  it('fails on another value, a provisional mark, a job, above 1, a missing order or another bottleneck', () => {
    type Shown = ReturnType<typeof screen>;
    const order = (s: Shown, i: number) => {
      const found = s.orders[ids[i] ?? ''];
      if (!found) throw new Error(`no order ${String(i)}`);
      return found;
    };
    const cases: [string, (s: Shown) => void][] = [
      [
        'decimal',
        (s) => {
          order(s, 0).oee.decimal = '0.6301';
        },
      ],
      [
        'fraction',
        (s) => {
          order(s, 1).quality.fraction = '18/20';
        },
      ],
      [
        'final',
        (s) => {
          order(s, 2).firstPassYield.final = 'false';
        },
      ],
      [
        'job',
        (s) => {
          order(s, 3).jobs = [{ id: 'other', oee: '0.6300', final: 'true' }];
        },
      ],
      [
        'job final',
        (s) => {
          const job = order(s, 3).jobs[0];
          if (job) job.final = 'false';
        },
      ],
      [
        'order above 1',
        (s) => {
          order(s, 4).line.aboveOne = 'true';
        },
      ],
      [
        'line above 1',
        (s) => {
          s.line.aboveOne = 'false';
        },
      ],
      [
        'count',
        (s) => {
          s.orders = Object.fromEntries(Object.entries(s.orders).slice(1));
        },
      ],
      [
        'line',
        (s) => {
          s.line.oee = ratio('1/1', '1.0000');
        },
      ],
      [
        'work center',
        (s) => {
          s.line.workCenterBottleneck = [{ id: 'x', equipment: 'cnc-01' }];
        },
      ],
    ];
    for (const [name, change] of cases) {
      const { ctx, failures } = screenContext();
      const shown = screen();
      change(shown);
      checkOeeScreen(ctx, shown, expected);
      expect(failures, name).toHaveLength(1);
    }
    const { ctx, failures } = screenContext();
    checkOeeScreen(ctx, { orders: {} }, expected);
    expect(failures[0]).toContain('oee-screen.json');
  });
});
