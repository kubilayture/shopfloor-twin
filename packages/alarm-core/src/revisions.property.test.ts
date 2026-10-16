/**
 * Revision completeness (review of #139): for a random scope and a random late fact (a raise
 * that arrives late, or an end that moves), every hour whose KPIs differ before and after the fact,
 * in the plant and in each position, must be among `revisedHours` of the plant scope after the
 * fact; and so must an hour of every range whose bad actors change.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { badActors } from './bad-actors.ts';
import { kpisOfBucket } from './buckets.ts';
import { floodEpisodes } from './floods.ts';
import { HOUR, prepare, type AlarmKpiConfig, type Occurrence } from './occurrences.ts';
import { revisedHours, type LateFact } from './revisions.ts';
import { scopeOccurrences } from './scopes.ts';

/** Small thresholds, so floods, chattering and standing alarms are frequent. */
const CONFIG: AlarmKpiConfig = {
  floodThreshold: 3,
  windowMs: 600_000,
  chatterCount: 2,
  chatterWindowMs: 60_000,
  fleetingMs: 1_000,
  standingMs: 2 * HOUR,
};

const POSITIONS = [
  { id: 'p1', equipment: ['a'] },
  { id: 'p2', equipment: ['b', 'c'] },
];
const SPAN = 8 * HOUR;

const json = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? String(v) : v));

/** Per hour the KPIs, and per half of the span (two "shifts") the bad actors. */
function snapshot(
  occurrences: readonly Occurrence[],
  closedAt: number | null,
  scope: string,
): Map<number, string> {
  const scoped = scopeOccurrences(occurrences, POSITIONS).get(scope) ?? [];
  const set = prepare(scoped, { asOf: SPAN, closedAt }, CONFIG);
  const episodes = floodEpisodes(set);
  const out = new Map<number, string>();
  for (let hour = 0; hour < SPAN; hour += HOUR) {
    out.set(hour, json(kpisOfBucket(set, episodes, { from: hour, to: hour + HOUR })));
  }
  out.set(-1, json(badActors(set, { from: 0, to: SPAN / 2 })));
  out.set(-2, json(badActors(set, { from: SPAN / 2, to: SPAN })));
  return out;
}

const scenarioArb = fc
  .record({
    closed: fc.option(fc.integer({ min: 7 * HOUR, max: SPAN - 1 }), { nil: null }),
    base: fc.integer({ min: 0, max: 6 * HOUR }),
    raises: fc.array(
      fc.record({
        equipment: fc.constantFrom('a', 'b', 'c'),
        code: fc.constantFrom('X', 'Y'),
        offset: fc.oneof(
          fc.integer({ min: 0, max: 1_500_000 }),
          fc.integer({ min: 0, max: 3 * HOUR }),
        ),
        duration: fc.constantFrom(500, 999, 1_000, 30_000, 3 * HOUR, -1),
      }),
      { minLength: 2, maxLength: 18 },
    ),
    pick: fc.nat(),
    late: fc.constantFrom('raise', 'end'),
    moved: fc.option(fc.integer({ min: 0, max: 4 * HOUR }), { nil: null }),
  })
  .map((scenario) => {
    const limit = scenario.closed ?? SPAN;
    const seqs = new Map<string, number>();
    const occurrences: Occurrence[] = [];
    for (const raise of scenario.raises) {
      const raisedAt = scenario.base + raise.offset;
      if (raisedAt > limit) continue;
      const seq = (seqs.get(raise.equipment) ?? 0) + 1;
      seqs.set(raise.equipment, seq);
      const clearedAt =
        raise.duration < 0 || raisedAt + raise.duration > limit ? null : raisedAt + raise.duration;
      occurrences.push({
        equipment: raise.equipment,
        code: raise.code,
        priority: 'high',
        seq,
        raisedAt,
        clearedAt,
      });
    }
    return { ...scenario, limit, occurrences };
  })
  .filter((scenario) => scenario.occurrences.length >= 2);

describe('revision completeness', () => {
  it('revises every hour and range a late fact changes, in every scope', () => {
    fc.assert(
      fc.property(scenarioArb, ({ occurrences, pick, late, moved, closed, limit }) => {
        const k = pick % occurrences.length;
        const target = occurrences[k];
        if (target === undefined) return;
        let before: Occurrence[];
        let fact: LateFact;
        if (late === 'raise') {
          before = occurrences.filter((_, i) => i !== k);
          fact = { kind: 'raise', ...target };
        } else {
          const alternative = moved === null ? null : Math.min(limit, target.raisedAt + moved);
          before = occurrences.map((o, i) => (i === k ? { ...o, clearedAt: alternative } : o));
          fact = {
            kind: 'end',
            raisedAt: target.raisedAt,
            before: alternative,
            after: target.clearedAt,
          };
        }
        const hours = new Set(
          revisedHours(fact, prepare(occurrences, { asOf: SPAN, closedAt: closed }, CONFIG)),
        );
        for (const scope of ['plant', 'p1', 'p2']) {
          const was = snapshot(before, closed, scope);
          for (const [key, value] of snapshot(occurrences, closed, scope)) {
            if (was.get(key) === value) continue;
            if (key >= 0) {
              expect(hours.has(key), `${scope} hour ${String(key / HOUR)}`).toBe(true);
            } else {
              const from = key === -1 ? 0 : SPAN / 2;
              const inRange = [...hours].some((hour) => hour >= from && hour < from + SPAN / 2);
              expect(inRange, `${scope} bad actors ${String(key)}`).toBe(true);
            }
          }
        }
      }),
      { numRuns: 1_000 },
    );
    // Each run recomputes every hour twice; on a loaded CI runner 1,000 runs take several seconds.
  }, 60_000);
});
