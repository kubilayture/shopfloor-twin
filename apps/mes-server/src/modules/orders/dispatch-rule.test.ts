/** The dispatch rule's estimate and choice (#174, ADR-0030 "Dispatches"). */
import { describe, expect, it } from 'vitest';
import { chooseCnc, estimateFinish, type ProductTimes } from './dispatch-rule.ts';

const MIN = 60_000;
const times: ProductTimes = {
  idealMs: (product) => (product === 'VB-100' ? 4 * MIN : 5.5 * MIN),
  changeoverMs: () => 25 * MIN,
};

describe('dispatch rule', () => {
  it('estimates a queue: NotBefore waits, changeovers (none→ too) and quantity × ideal OP10 cycle', () => {
    expect(estimateFinish({ loaded: undefined, jobs: [] }, times)).toBe(Number.NEGATIVE_INFINITY);
    expect(estimateFinish({ loaded: undefined, jobs: [] }, times, 5)).toBe(5);
    const first = { product: 'VB-100', quantity: 10, notBefore: 0 };
    // none→VB-100 changeover, then 10 × 4 min.
    expect(estimateFinish({ loaded: undefined, jobs: [first] }, times)).toBe(25 * MIN + 40 * MIN);
    // Already loaded: no changeover.
    expect(estimateFinish({ loaded: 'VB-100', jobs: [first] }, times)).toBe(40 * MIN);
    // The next job waits for its NotBefore, then changes over to VB-200.
    const later = { product: 'VB-200', quantity: 2, notBefore: 120 * MIN };
    expect(estimateFinish({ loaded: 'VB-100', jobs: [first, later] }, times)).toBe(
      120 * MIN + 25 * MIN + 11 * MIN,
    );
    // Starting no earlier than `from`.
    expect(estimateFinish({ loaded: 'VB-100', jobs: [first] }, times, 10 * MIN)).toBe(50 * MIN);
  });

  it('chooses the CNC finishing first with the job appended; ties go to the lower id', () => {
    const job = { product: 'VB-100', quantity: 5, notBefore: 0 };
    expect(
      chooseCnc(
        [
          { equipment: 'cnc-02', loaded: undefined, jobs: [] },
          { equipment: 'cnc-01', loaded: undefined, jobs: [] },
        ],
        job,
        times,
      ),
    ).toBe('cnc-01');
    // cnc-02 has VB-100 loaded: no changeover, so it finishes first.
    expect(
      chooseCnc(
        [
          { equipment: 'cnc-01', loaded: undefined, jobs: [] },
          { equipment: 'cnc-02', loaded: 'VB-100', jobs: [] },
        ],
        job,
        times,
      ),
    ).toBe('cnc-02');
    expect(chooseCnc([], job, times)).toBeUndefined();
  });
});
