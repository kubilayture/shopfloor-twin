import { describe, expect, it } from 'vitest';
import { ConsumptionTracker, attachConsumption, type ConsumptionEvent } from './consumption.ts';

const consumed = (machineId: string, partId: number, material: string, lotId: string) =>
  ({ type: 'material-consumed', machineId, partId, material, lotId }) as const;
const cycle = (machineId: string, partId: number) =>
  ({ type: 'cycle-complete', machineId, partId }) as const;
const operator = (machineId: string, operatorId: string | null) =>
  ({ type: 'operator', machineId, operatorId }) as const;

describe('attachConsumption', () => {
  it('attaches the blank lot to the OP10 cycle and nothing to a washer cycle', () => {
    const events: ConsumptionEvent[] = [
      { type: 'shift', at: 0 } as ConsumptionEvent,
      consumed('cnc-01', 1, 'BLANK-100', 'BL-1'),
      { type: 'state', machineId: 'cnc-01' },
      cycle('cnc-01', 1),
      cycle('wsh-01', 1),
    ];
    expect(attachConsumption(events)).toEqual([
      null,
      null,
      null,
      { lots: [{ material: 'BLANK-100', lot: 'BL-1' }], operator: null },
      { lots: [], operator: null },
    ]);
  });

  it('takes the operator at the cycle start, not at its end', () => {
    const events = [
      operator('asm-01', 'OP-A'),
      consumed('asm-01', 7, 'SK-1', 'SK1-01'),
      consumed('asm-01', 7, 'SP-100', 'SP-01'),
      operator('asm-01', 'OP-B'), // shift change while the cycle runs
      cycle('asm-01', 7),
      consumed('asm-01', 8, 'SK-1', 'SK1-02'),
      cycle('asm-01', 8),
    ];
    const result = attachConsumption(events);
    expect(result[4]).toEqual({
      lots: [
        { material: 'SK-1', lot: 'SK1-01' },
        { material: 'SP-100', lot: 'SP-01' },
      ],
      operator: 'OP-A',
    });
    expect(result[6]).toEqual({ lots: [{ material: 'SK-1', lot: 'SK1-02' }], operator: 'OP-B' });
  });

  it('keeps parts on different machines apart and attaches a rework pass its own lots', () => {
    const events = [
      operator('asm-01', null),
      consumed('cnc-01', 2, 'BLANK-100', 'BL-1'),
      consumed('asm-01', 1, 'SK-1', 'SK1-01'),
      cycle('cnc-01', 2),
      cycle('asm-01', 1),
      operator('asm-01', 'OP-C'),
      consumed('asm-01', 1, 'SK-1', 'SK1-02'), // the rework pass of part 1
      cycle('asm-01', 1),
    ];
    const result = attachConsumption(events);
    expect(result[3]?.lots).toEqual([{ material: 'BLANK-100', lot: 'BL-1' }]);
    expect(result[4]).toEqual({ lots: [{ material: 'SK-1', lot: 'SK1-01' }], operator: null });
    expect(result[7]).toEqual({ lots: [{ material: 'SK-1', lot: 'SK1-02' }], operator: 'OP-C' });
  });

  it('reports material of a cycle that never completes by no cycle', () => {
    const tracker = new ConsumptionTracker();
    expect(tracker.record(consumed('cnc-01', 9, 'BLANK-100', 'BL-1'))).toBeNull();
    expect(tracker.record(cycle('cnc-02', 9))).toEqual({ lots: [], operator: null });
  });

  it('ignores events without a machine or part and refuses a consumption without a lot', () => {
    const tracker = new ConsumptionTracker();
    expect(tracker.record({ type: 'operator' })).toBeNull();
    expect(tracker.record({ type: 'cycle-complete', machineId: 'x' })).toBeNull();
    expect(tracker.record({ type: 'material-consumed', machineId: 'x' })).toBeNull();
    expect(() =>
      tracker.record({ type: 'material-consumed', machineId: 'x', partId: 1, material: 'M' }),
    ).toThrow(/without a lot/);
  });
});
