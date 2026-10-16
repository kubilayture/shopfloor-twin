import { describe, expect, it } from 'vitest';
import { judgeLatency, pageActivityProblems, snapshotAgreement, type Change } from './latency.ts';

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

  it('refuses a frozen page that matches only because the truth returned to its state', () => {
    // Running → Stopped (170 ms) → Running, again and again; the page shows Running throughout.
    const truth: Change[] = [];
    for (let at = 1_000; at < 60_000; at += 5_000) {
      truth.push({ at, state: 'Stopped' }, { at: at + 170, state: 'Running' });
    }
    const frozen = new Map([['m', [{ at: 0, state: 'Running' }]]]);
    const judged = judgeLatency(new Map([['m', truth]]), frozen, 100_000, 2_000);
    // Every Stopped is a violation, but each Running "matches" the frozen page at once.
    expect(judged.measured.filter((m) => m.latencyMs === 0)).toHaveLength(12);
    expect(pageActivityProblems(judged.measured, frozen)).toEqual([
      'the page changed state 0 times for 24 judged changes',
      'm: the page never changed state, the truth did',
    ]);
    // A live page that shows the Stopped states passes.
    const live = new Map([
      ['m', [{ at: 0, state: 'Running' }, ...truth.map((c) => ({ ...c, at: c.at + 100 }))]],
    ]);
    expect(
      pageActivityProblems(
        judgeLatency(new Map([['m', truth]]), live, 100_000, 2_000).measured,
        live,
      ),
    ).toEqual([]);
  });

  it('wants a transition on every machine whose truth changed', () => {
    const measured = [
      { machine: 'a', at: 1, state: 'Down', latencyMs: 0 },
      { machine: 'b', at: 1, state: 'Down', latencyMs: 0 },
    ];
    const page = new Map([
      [
        'a',
        [
          { at: 0, state: 'Idle' },
          { at: 1, state: 'Down' },
          { at: 2, state: 'Idle' },
        ],
      ],
      ['b', [{ at: 0, state: 'Down' }]],
    ]);
    expect(pageActivityProblems(measured, page)).toEqual([
      'b: the page never changed state, the truth did',
    ]);
  });
});

describe('OEE values within the limit (#123, Phase 5 exit criterion 5)', () => {
  // The API's OEE changes about twice a second; the page takes a push at most once a second.
  const truth: Change[] = [
    { at: 1_000, state: '0.8001' },
    { at: 1_500, state: '0.8002' },
    { at: 2_000, state: '0.8003' },
    { at: 2_500, state: '0.8004' },
  ];
  const observed = new Map([['wc', new Set(['0.8000', ...truth.map((c) => c.state)])]]);
  const judge = (page: Change[]) =>
    judgeLatency(new Map([['wc', truth]]), new Map([['wc', page]]), 100_000, 2_000, {
      observed,
    });

  it('accepts a later value for skipped ones', () => {
    const result = judge([
      { at: 0, state: '0.8000' },
      { at: 1_700, state: '0.8002' },
      { at: 2_700, state: '0.8004' },
    ]);
    expect(result.violations).toEqual([]);
    expect(result.measured.map((m) => m.latencyMs)).toEqual([700, 200, 700, 200]);
  });

  it('accepts a value the polls missed only when the page took it after the change', () => {
    // 0.80035 was held between two polls, after 0.8003 was seen.
    const missed = { at: 2_300, state: '0.80035' };
    const result = judge([{ at: 0, state: '0.8000' }, missed]);
    // 0.8001 to 0.8003: the page took the missed value after them; 0.8004 never came.
    expect(result.measured.map((m) => m.latencyMs)).toEqual([1_300, 800, 300, undefined]);
    // Without `observed`, an unknown value never counts.
    const strict = judgeLatency(
      new Map([['wc', truth]]),
      new Map([['wc', [{ at: 0, state: '0.8000' }, missed]]]),
      100_000,
      2_000,
    );
    expect(strict.violations).toHaveLength(4);
  });

  it('refuses a page stuck on a stale value', () => {
    const result = judge([{ at: 0, state: '0.8000' }]);
    expect(result.violations).toHaveLength(4);
  });

  it('lowers the frozen-page ratio for a paced page', () => {
    const page = [
      { at: 0, state: '0.8000' },
      { at: 1_700, state: '0.8002' },
    ];
    const { measured } = judge(page);
    const pages = new Map([['wc', page]]);
    expect(pageActivityProblems(measured, pages)).toEqual([
      'the page changed state 1 times for 4 judged changes',
    ]);
    expect(pageActivityProblems(measured, pages, 0.25)).toEqual([]);
  });

  it('compares snapshots with what the API held around their moment', () => {
    const api = new Map([['wc', [{ at: 0, state: '0.8000' }, ...truth]]]);
    const agreement = snapshotAgreement(
      [
        { at: 1_200, values: { wc: '0.8001' } }, // held now
        { at: 2_600, values: { wc: '0.8001' } }, // held until 1.5 s: within 2 s before
        { at: 4_000, values: { wc: '0.8001' } }, // stale by 2.5 s
        { at: 900, values: { wc: '0.8001' } }, // the API took it 100 ms later
        { at: 1_000, values: { wc: '0.7999' } }, // never held
      ],
      api,
      2_000,
      500,
    );
    expect(agreement).toEqual({
      compared: 5,
      matched: 3,
      matchedPerKey: { wc: 3 },
      mismatches: [
        'wc at 1970-01-01T00:00:04.000Z: page 0.8001',
        'wc at 1970-01-01T00:00:01.000Z: page 0.7999',
      ],
    });
  });
});
