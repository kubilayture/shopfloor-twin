import { describe, expect, it } from 'vitest';
import { SLOW_FACTOR, reconciliationSuite, reportDuration } from './reconcile.test-support.ts';

// The golden seed from Friday 14:00 to Saturday 08:00 (Istanbul): shift B, the Friday night
// shift C, which ends on Saturday, then the weekend's no-shift bucket. The whole golden week runs
// in the end-to-end job (reconciliation-week.e2e.test.ts).
reconciliationSuite('reconciliation with the headless ground truth: Friday night (#96)', () =>
  Promise.resolve({
    seed: 20261012,
    start: '2026-10-16T14:00:00+03:00',
    days: 18 / 24,
    settledToEnd: true,
    // Measured without extra load (#218): 17 s to 20 s and 22 s to 26 s.
    quietMs: { inOrder: 18_000, shuffled: 24_000 },
  }),
);

describe('reconciliation durations (#218)', () => {
  it('logs every run and warns, never fails, past SLOW_FACTOR times the quiet baseline', () => {
    const warnings: string[] = [];
    const warn = (line: string) => warnings.push(line);
    expect(reportDuration('t', 'in order', 30_000, 20_000, warn)).toBe(
      't: in order took 30.0 s, 1.50× its quiet baseline of 20 s',
    );
    reportDuration('t', 'in order', SLOW_FACTOR * 20_000, 20_000, warn);
    expect(warnings).toEqual([]);
    reportDuration('t', 'shuffled', SLOW_FACTOR * 20_000 + 1, 20_000, warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^SLOW \(2\.5× quiet exceeded\): t: shuffled took 50\.0 s, 2\.50×/);
    expect(reportDuration('t', 'shuffled', 1_000, undefined, warn)).toMatch(/no quiet baseline/);
    expect(warnings).toHaveLength(1);
  });
});
