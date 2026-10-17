import { describe, expect, it } from 'vitest';
import { windowOf } from './quality.ts';

// A signal's suggested hold scope (#201, review of PR #222 L3): the readings since the last
// in-control point before the episode, or since its segment's start.

const E1 = 100;
const E2 = 200;
const at = (epoch: number, seq: number) => ({ epoch, at: seq * 1_000, seq });
const reading = (epoch: number, seq: number, partId = seq, pass = 1) => ({
  ...at(epoch, seq),
  key: `${String(epoch)}/${String(partId)}/${String(pass)}`,
});
const point = (epoch: number, seq: number, segment: number, rules: number[] = []) => ({
  position: at(epoch, seq),
  segment,
  rules,
});

describe('windowOf', () => {
  it('starts after the last point without a rule before the episode, retests included', () => {
    const points = [point(E1, 1, 0), point(E1, 2, 0), point(E1, 3, 0, [2]), point(E1, 4, 0, [1])];
    const readings = [1, 2, 3, 4].map((s) => reading(E1, s)).concat([reading(E1, 5, 2, 2)]);
    const window = windowOf(points, readings, at(E1, 4), at(E1, 4));
    expect(window?.after).toEqual(at(E1, 2));
    expect(window?.from).toEqual(at(E1, 3));
    expect(window?.readings.map((r) => [r.partId, r.pass])).toEqual([
      [3, 1],
      [4, 1],
    ]);
  });

  it('starts at the segment’s first reading when no point before the episode is in control', () => {
    // An in-control point of the earlier segment (epoch) does not end the walk back: the window
    // starts at the episode's segment start and holds no reading of the earlier epoch.
    const points = [
      point(E1, 1, 0),
      point(E2, 1, 1, [1]),
      point(E2, 2, 1, [1]),
      point(E2, 3, 1, [1]),
    ];
    const readings = [
      reading(E1, 1),
      reading(E2, 1),
      reading(E2, 2),
      reading(E2, 3),
      reading(E2, 4),
    ];
    const window = windowOf(points, readings, at(E2, 2), at(E2, 3));
    expect(window?.after).toBeNull();
    expect(window?.from).toEqual(at(E2, 1));
    expect(window?.through).toEqual(at(E2, 3));
    expect(window?.readings.map((r) => [r.epoch, r.seq])).toEqual([
      [E2, 1],
      [E2, 2],
      [E2, 3],
    ]);
    // The episode's first point at the segment's very start.
    expect(windowOf(points, readings, at(E2, 1), at(E2, 1))?.from).toEqual(at(E2, 1));
    expect(windowOf(points, readings, at(E2, 9), at(E2, 9))).toBeUndefined();
  });
});
