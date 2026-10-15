import type { IntervalDto } from '@shopfloor/contracts/mes-api';
import { describe, expect, it } from 'vitest';
import { current, EPOCH } from '../test/fixtures.ts';
import { stateTotals, timelineBands, withLiveState } from './timeline.ts';

const T0 = Date.parse('2026-10-15T06:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

function interval(state: string, from: number, to: number, provisional = false): IntervalDto {
  return {
    epoch: EPOCH,
    start: at(from),
    end: at(to),
    state,
    cause: state === 'Down' ? 'spindle-fault' : null,
    provisional,
    intervalStart: at(from),
    startSeq: from,
  };
}

const window = { from: T0, to: T0 + 60 * 60_000 };

describe('timelineBands', () => {
  it('places bands in percent of the window, clipped, empty ones left out', () => {
    const bands = timelineBands(
      withLiveState(
        [
          interval('Running', -10, 15),
          interval('Down', 15, 30),
          interval('Idle', 30, 30),
          interval('Running', 30, 90),
        ],
        undefined,
        undefined,
      ),
      window,
    );
    expect(bands.map(({ state, left, width }) => ({ state, left, width }))).toEqual([
      { state: 'Running', left: 0, width: 25 },
      { state: 'Down', left: 25, width: 25 },
      { state: 'Running', left: 50, width: 50 },
    ]);
    expect(bands[1]?.cause).toBe('spindle-fault');
  });

  it('returns nothing for an empty window', () => {
    expect(timelineBands([], { from: T0, to: T0 })).toEqual([]);
  });

  it('band widths add up to the covered share and never overlap', () => {
    const intervals = Array.from({ length: 12 }, (_, index) =>
      interval(index % 2 === 0 ? 'Running' : 'Starved', index * 5, index * 5 + 5),
    );
    const bands = timelineBands(withLiveState(intervals, undefined, undefined), window);
    expect(bands.reduce((sum, band) => sum + band.width, 0)).toBeCloseTo(100, 9);
    for (let index = 1; index < bands.length; index += 1) {
      expect(bands[index]?.start).toBeGreaterThanOrEqual(bands[index - 1]?.end ?? 0);
    }
  });
});

describe('withLiveState', () => {
  it('draws the live state from its start to the plant clock', () => {
    const spans = withLiveState(
      [interval('Running', 0, 20), interval('Down', 20, 40, true)],
      current({ state: 'Running', since: at(30), seq: 99 }),
      T0 + 45 * 60_000,
    );
    expect(spans.map((span) => [span.state, span.start, span.end, span.provisional])).toEqual([
      ['Running', T0, T0 + 20 * 60_000, false],
      ['Down', T0 + 20 * 60_000, T0 + 30 * 60_000, true],
      ['Running', T0 + 30 * 60_000, T0 + 45 * 60_000, true],
    ]);
  });

  it('extends the stored open interval of the same state to the clock', () => {
    const spans = withLiveState(
      [interval('Down', 20, 40, true)],
      current({ state: 'Down', since: at(20) }),
      T0 + 50 * 60_000,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.end).toBe(T0 + 50 * 60_000);
  });

  it('leaves the stored intervals alone when the live state is older', () => {
    const stored = [interval('Running', 0, 20), interval('Idle', 20, 40, true)];
    const spans = withLiveState(stored, current({ since: at(10) }), T0 + 50 * 60_000);
    expect(spans.map((span) => span.state)).toEqual(['Running', 'Idle']);
  });
});

describe('stateTotals', () => {
  it('sums time per state, longest first, with shares', () => {
    const bands = timelineBands(
      withLiveState(
        [interval('Running', 0, 30), interval('Down', 30, 45), interval('Running', 45, 60)],
        undefined,
        undefined,
      ),
      window,
    );
    expect(stateTotals(bands)).toEqual([
      { state: 'Running', ms: 45 * 60_000, share: 0.75 },
      { state: 'Down', ms: 15 * 60_000, share: 0.25 },
    ]);
    expect(stateTotals([])).toEqual([]);
  });
});
