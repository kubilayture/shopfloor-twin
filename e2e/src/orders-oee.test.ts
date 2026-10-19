import { describe, expect, it } from 'vitest';
import {
  SHIFT_A_COMPLETED,
  checkOeeScreen,
  type OeeExpected,
  type PassContext,
} from './orders-pass.ts';

const ratio = (fraction: string, decimal: string) => ({ fraction, decimal });

const ids = Array.from({ length: SHIFT_A_COMPLETED }, (_, i) => `PO-2610-00${String(i + 1)}`);

const expected: OeeExpected = {
  orders: Object.fromEntries(
    ids.map((id) => [
      id,
      {
        oee: {
          availability: ratio('4/5', '0.8000'),
          performance: ratio('7/8', '0.8750'),
          quality: ratio('9/10', '0.9000'),
          oee: ratio('63/100', '0.6300'),
        },
        firstPassYield: { firstPassGood: 9, started: 10, yield: ratio('9/10', '0.9000') },
        line: ratio('3/16', '0.1875'),
      },
    ]),
  ),
  shiftKey: '2026-10-12/A',
  line: ratio('21/20', '1.0500'),
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
  const order = {
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
    line: { final: 'true', oee: ratio('3/16', '0.1875') },
  };
  return {
    orders: Object.fromEntries(ids.map((id) => [id, structuredClone(order)])),
    line: {
      key: '2026-10-12/A',
      final: 'true',
      oee: ratio('21/20', '1.0500'),
      bottlenecks: [{ product: 'VB-100', operation: 'OP30', equipment: 'asm-01' }],
      workCenterBottleneck: [{ id: 'bottleneck-line-a1', equipment: 'asm-01' }],
    },
  };
}

function context() {
  const failures: string[] = [];
  const ctx = { fail: (m: string) => failures.push(m) } as unknown as PassContext;
  return { ctx, failures };
}

describe('checkOeeScreen (#233)', () => {
  it('passes when the page shows the truth’s values for exactly the expected orders', () => {
    const { ctx, failures } = context();
    const result = checkOeeScreen(ctx, screen(), expected);
    expect(failures).toEqual([]);
    expect(result).toMatchObject({ orders: SHIFT_A_COMPLETED, equal: true, line: '1.0500' });
  });

  it('fails on another value, a provisional mark, a missing order or another bottleneck', () => {
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
      const { ctx, failures } = context();
      const shown = screen();
      change(shown);
      checkOeeScreen(ctx, shown, expected);
      expect(failures, name).toHaveLength(1);
    }
    const { ctx, failures } = context();
    checkOeeScreen(ctx, { orders: {} }, expected);
    expect(failures[0]).toContain('oee-screen.json');
  });
});
