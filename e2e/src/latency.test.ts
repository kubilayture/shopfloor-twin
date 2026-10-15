import { describe, expect, it } from 'vitest';
import { judgeLatency, type Change } from './latency.ts';

const run = (truth: Change[], page: Change[], until = 100_000, limit = 2_000) =>
  judgeLatency(new Map([['m', truth]]), new Map([['m', page]]), until, limit);

describe('latest state within the limit (#100, exit criterion 3)', () => {
  it('measures the delay until the page shows the new state', () => {
    const result = run(
      [
        { at: 1_000, state: 'Running' },
        { at: 5_000, state: 'Down' },
      ],
      [
        { at: 0, state: 'Off' },
        { at: 1_300, state: 'Running' },
        { at: 5_150, state: 'Down' },
      ],
    );
    expect(result.violations).toEqual([]);
    expect(result.measured.map((m) => m.latencyMs)).toEqual([300, 150]);
  });

  it('accepts a later state instead of a skipped one, but not a stale one', () => {
    // Stopped lasted 170 ms; the page went straight from Running to Idle.
    const truth = [
      { at: 1_000, state: 'Stopped' },
      { at: 1_170, state: 'Idle' },
    ];
    const ok = run(truth, [
      { at: 0, state: 'Running' },
      { at: 1_400, state: 'Idle' },
    ]);
    expect(ok.violations).toEqual([]);
    expect(ok.measured.map((m) => m.latencyMs)).toEqual([400, 230]);
    // The page still shows Running 2 s later: both changes are violations.
    const stale = run(truth, [{ at: 0, state: 'Running' }]);
    expect(stale.violations.map((v) => v.state)).toEqual(['Stopped', 'Idle']);
  });

  it('counts a state shown before the truth returned to it from the moment of return', () => {
    // Running → (Starved, missed by the poll) → Running: the page shows Starved late.
    const result = run(
      [
        { at: 0, state: 'Running' },
        { at: 2_000, state: 'Running' },
      ],
      [
        { at: 0, state: 'Running' },
        { at: 1_900, state: 'Starved' },
        { at: 2_600, state: 'Running' },
      ],
    );
    expect(result.measured.map((m) => m.latencyMs)).toEqual([0, 600]);
  });

  it('leaves changes whose deadline is after the end of sampling unjudged', () => {
    const result = run([{ at: 99_000, state: 'Down' }], [{ at: 0, state: 'Off' }]);
    expect(result).toEqual({ measured: [], violations: [], unjudged: 1 });
  });
});
