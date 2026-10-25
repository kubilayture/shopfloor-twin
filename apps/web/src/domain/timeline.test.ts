import type { IntervalDto } from '@shopfloor/contracts/mes-api';
import { describe, expect, it } from 'vitest';
import { current, EPOCH } from '../test/fixtures.ts';
import { MAX_TICKS, stateTotals, timelineBands, timelineTicks, withLiveState } from './timeline.ts';

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

describe('timelineTicks', () => {
  // 06:10 UTC is 09:10 plant time (Europe/Istanbul, UTC+3).
  const to = Date.parse('2026-10-15T06:10:00.000Z');
  const ticksOf = (hours: number) =>
    timelineTicks({ from: to - hours * 3_600_000, to }).map((tick) =>
      tick.date === undefined ? tick.time : `${tick.date} ${tick.time}`,
    );

  it('puts a tick every 10 min over an hour, at round plant times, both ends included', () => {
    expect(ticksOf(1)).toEqual(['08:10', '08:20', '08:30', '08:40', '08:50', '09:00', '09:10']);
  });

  it('puts a tick every hour over 8 h, positioned in percent of the window', () => {
    const ticks = timelineTicks({ from: to - 8 * 3_600_000, to });
    expect(ticks.map((tick) => tick.time)).toEqual([
      '02:00',
      '03:00',
      '04:00',
      '05:00',
      '06:00',
      '07:00',
      '08:00',
      '09:00',
    ]);
    expect(ticks[0]?.left).toBeCloseTo((50 / 480) * 100, 6);
    expect(ticks.every((tick) => tick.date === undefined)).toBe(true);
  });

  it('dates the first tick and the first of each new plant day when the window spans days', () => {
    expect(ticksOf(24)).toEqual([
      'Wed 14 Oct 12:00',
      '15:00',
      '18:00',
      '21:00',
      'Thu 15 Oct 00:00',
      '03:00',
      '06:00',
      '09:00',
    ]);
    // 8 h across midnight: dated too.
    const night = Date.parse('2026-10-14T23:30:00.000Z'); // 02:30 plant time on the 15th
    expect(
      timelineTicks({ from: night - 8 * 3_600_000, to: night })
        .filter((tick) => tick.date !== undefined)
        .map((tick) => `${tick.date ?? ''} ${tick.time}`),
    ).toEqual(['Wed 14 Oct 19:00', 'Thu 15 Oct 00:00']);
  });

  it('gives no tick for an empty window and at most eight otherwise', () => {
    expect(timelineTicks({ from: to, to })).toEqual([]);
    for (const hours of [0.25, 1, 2, 5, 8, 12, 24, 48, 24 * 7]) {
      expect(ticksOf(hours).length, String(hours)).toBeLessThanOrEqual(MAX_TICKS);
      expect(ticksOf(hours).length, String(hours)).toBeGreaterThan(0);
    }
  });
});
