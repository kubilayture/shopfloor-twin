import { describe, expect, it } from 'vitest';
import { badActors } from './bad-actors.ts';
import { bucketKpis, composeBuckets, hoursOf, kpisOfBucket } from './buckets.ts';
import { floodEpisodes } from './floods.ts';
import {
  HOUR,
  compareRaises,
  prepare,
  type AlarmKpiConfig,
  type Occurrence,
} from './occurrences.ts';
import { revisedHours, revisionSpans } from './revisions.ts';
import { priorityFromSeverity, scopeOccurrences } from './scopes.ts';

const CONFIG: AlarmKpiConfig = {
  floodThreshold: 10,
  windowMs: 600_000,
  chatterCount: 3,
  chatterWindowMs: 60_000,
  fleetingMs: 1_000,
  standingMs: 86_400_000,
};

const T0 = Date.UTC(2026, 9, 12, 10);

const occ = (
  equipment: string,
  code: string,
  seq: number,
  raisedAt: number,
  clearedAt: number | null = null,
): Occurrence => ({ equipment, code, priority: 'medium', seq, raisedAt, clearedAt });

describe('prepare', () => {
  it('refuses invalid thresholds, times and order', () => {
    expect(() => prepare([], { asOf: T0 }, { ...CONFIG, windowMs: 700_000 })).toThrow(/divide/);
    expect(() => prepare([], { asOf: T0 }, { ...CONFIG, chatterCount: 0 })).toThrow(/positive/);
    expect(() => prepare([], { asOf: T0 + 0.5 }, CONFIG)).toThrow(/integer/);
    expect(() => prepare([], { asOf: T0, closedAt: T0 + 0.5 }, CONFIG)).toThrow(/integer/);
    expect(() => prepare([occ('a', 'X', 1.5, T0)], { asOf: T0 }, CONFIG)).toThrow(/integers/);
    expect(() => prepare([occ('a', 'X', 1, T0, T0 - 1)], { asOf: T0 }, CONFIG)).toThrow(/after/);
    expect(() => prepare([occ('a', 'X', 1, T0 + 5)], { asOf: T0, closedAt: T0 }, CONFIG)).toThrow(
      /raise after the epoch/,
    );
    expect(() =>
      prepare([occ('a', 'X', 1, T0, T0 + 5)], { asOf: T0 + 9, closedAt: T0 + 1 }, CONFIG),
    ).toThrow(/clear after the epoch/);
  });

  it('drops raises after asOf and keeps a clear after asOf open', () => {
    const set = prepare(
      [occ('a', 'X', 1, T0, T0 + 10), occ('a', 'Y', 2, T0 + 6)],
      { asOf: T0 + 5 },
      CONFIG,
    );
    expect(set.occurrences).toHaveLength(1);
    expect(set.occurrences[0]).toMatchObject({ clearedAt: null, endAt: null, endReason: null });
  });

  it('orders raises by time, seq, equipment and code', () => {
    const sorted = [
      occ('b', 'X', 1, T0),
      occ('a', 'Y', 1, T0),
      occ('a', 'X', 1, T0),
      occ('a', 'X', 0, T0),
    ].sort(compareRaises);
    expect(sorted.map((o) => `${o.equipment}/${o.code}/${String(o.seq)}`)).toEqual([
      'a/X/0',
      'a/X/1',
      'a/Y/1',
      'b/X/1',
    ]);
  });

  it('ends a superseded occurrence at the next raise only when that comes before its clear', () => {
    const set = prepare(
      [occ('a', 'X', 1, T0, T0 + 50), occ('a', 'X', 2, T0 + 100, T0 + 120)],
      { asOf: T0 + HOUR },
      CONFIG,
    );
    expect(set.occurrences.map((o) => o.endReason)).toEqual(['cleared', 'cleared']);
  });
});

describe('buckets', () => {
  it('refuses buckets off whole hours or empty', () => {
    expect(() => bucketKpis([], [{ from: T0 + 1, to: T0 + HOUR }], { asOf: T0 }, CONFIG)).toThrow(
      /whole UTC hours/,
    );
    expect(() => hoursOf({ from: T0, to: T0 })).toThrow(/non-empty/);
    expect(() => composeBuckets([], CONFIG)).toThrow(/at least one/);
  });

  it('measures a bucket that has not begun at asOf as empty and provisional', () => {
    const [kpis] = bucketKpis(
      [occ('a', 'X', 1, T0)],
      [{ from: T0 + HOUR, to: T0 + 2 * HOUR }],
      { asOf: T0 + 10 },
      CONFIG,
    );
    expect(kpis).toMatchObject({ raises: 0, activeMs: 0, activeAtEnd: 1, provisional: true });
  });

  it('lists an episode that ends exactly at a boundary only in the earlier bucket', () => {
    // 11 raises at 10:50:00 … 10:50:10 leave at 11:00:00 … 11:00:10; the first departure ends it.
    const raises = Array.from({ length: 11 }, (_, i) =>
      occ('a', `C${String(i)}`, i, T0 + 50 * 60_000),
    );
    const set = prepare(raises, { asOf: T0 + 2 * HOUR }, CONFIG);
    const episodes = floodEpisodes(set);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.endAt).toBe(T0 + HOUR);
    expect(
      kpisOfBucket(set, episodes, { from: T0, to: T0 + HOUR }).floods[0]?.ended,
    ).not.toBeNull();
    expect(kpisOfBucket(set, episodes, { from: T0 + HOUR, to: T0 + 2 * HOUR }).floods).toEqual([]);
  });

  it('goes on when the last counted raise leaves as another arrives', () => {
    const raises = Array.from({ length: 11 }, (_, i) =>
      occ('a', `C${String(i)}`, i, T0 + i * 1_000),
    );
    raises.push(occ('b', 'D', 1, T0 + 600_000));
    const episodes = floodEpisodes(prepare(raises, { asOf: T0 + HOUR }, CONFIG));
    expect(episodes.map((e) => [e.startAt - T0, (e.endAt ?? 0) - T0, e.raises])).toEqual([
      [10_000, 601_000, 2],
    ]);
  });
});

describe('bad actors', () => {
  it('keeps the top `limit` and ignores points without raises in the range', () => {
    const set = prepare(
      [
        occ('a', 'X', 1, T0 - 10, T0 + 100),
        occ('a', 'Y', 2, T0 + 5, T0 + 6),
        occ('b', 'Z', 1, T0 + 7),
      ],
      { asOf: T0 + 1_000 },
      CONFIG,
    );
    const actors = badActors(set, { from: T0, to: T0 + HOUR }, 1);
    expect(actors).toHaveLength(1);
    expect(actors[0]).toMatchObject({ equipment: 'b', code: 'Z', raises: 1, activeMs: 993 });
    expect(badActors(set, { from: T0 + HOUR, to: T0 + 2 * HOUR })).toEqual([]);
  });
});

describe('revisions', () => {
  it('covers a late raise that is still open and supersedes an earlier open occurrence', () => {
    const set = prepare(
      [occ('a', 'X', 1, T0), occ('a', 'X', 2, T0 + 2 * HOUR)],
      { asOf: T0 + 3 * HOUR + 5 },
      CONFIG,
    );
    const fact = {
      kind: 'raise',
      equipment: 'a',
      code: 'X',
      raisedAt: T0 + 2 * HOUR,
      clearedAt: null,
    } as const;
    expect(revisionSpans(fact, set)).toContainEqual({ from: T0 + 2 * HOUR, to: T0 + 3 * HOUR + 5 });
    expect(revisedHours(fact, set)).toEqual([T0 + 2 * HOUR, T0 + 3 * HOUR]);
    const end = { kind: 'end', raisedAt: T0, before: null, after: null } as const;
    expect(revisedHours(end, set)).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]);
  });
});

describe('scopes and priorities', () => {
  it('splits occurrences into the plant and each position', () => {
    const all = [occ('cnc-01', 'X', 1, T0), occ('pck-01', 'Y', 1, T0)];
    const scopes = scopeOccurrences(all, [
      { id: 'cell-m1', equipment: ['cnc-01'] },
      { id: 'line-a1', equipment: ['pck-01'] },
    ]);
    expect([...scopes.keys()]).toEqual(['plant', 'cell-m1', 'line-a1']);
    expect(scopes.get('plant')).toHaveLength(2);
    expect(scopes.get('line-a1')?.map((o) => o.equipment)).toEqual(['pck-01']);
    expect(() => scopeOccurrences(all, [{ id: 'plant', equipment: [] }])).toThrow(/plant/);
  });

  it('derives a priority from the wire severity', () => {
    expect([1, 333, 334, 666, 667, 1000].map(priorityFromSeverity)).toEqual([
      'low',
      'low',
      'medium',
      'medium',
      'high',
      'high',
    ]);
    expect(() => priorityFromSeverity(0)).toThrow(RangeError);
    expect(() => priorityFromSeverity(1001)).toThrow(RangeError);
    expect(() => priorityFromSeverity(1.5)).toThrow(RangeError);
  });
});
