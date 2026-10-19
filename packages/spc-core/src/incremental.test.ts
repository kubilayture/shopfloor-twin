/**
 * The incremental derivation equals the whole derivation (#238, Phase 9 exit criterion 8).
 *
 * Property: a random universe of readings (several device epochs, retests, equal positions told
 * apart by key, values tight around a centre with steps and outliers so every rule fires) is fed
 * to one `SpcDerivation` by a random script of operations, and after every operation its `chart()`
 * must equal `spcChart` over the readings it holds and the versions in force, exactly (points,
 * rules, segments, subgroups, pending and dropped readings, retests and every episode with its
 * extent, closing point and baseline flag). The operations: deliver a batch of the universe in a
 * random order (new readings at the end, late ones anywhere before it), deliver a batch again (a
 * duplicate changes nothing), remove readings, change a reading in place (value, position or pass,
 * as a part's rebuild renumbers its passes), create limit version 1 from the readings so far,
 * create a later version from a window of them applying from a position, and end the newest
 * open version at a position. Each update's `kind` is checked too: `new` exactly when it only
 * appended first-pass readings at the end of the chart.
 *
 * fast-check prints the seed and path of a failure; rerun one with `fc.assert(…, { seed, path })`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { firstVersion, spcChart, type LimitVersion } from './chart.ts';
import { SpcDerivation } from './incremental.ts';
import { estimateLimits } from './limits.ts';
import { comparePositions, firstPass, type Position, type Reading } from './readings.ts';
import { DEFAULT_RULES, RULES, type RuleSet } from './rules.ts';

const SIZE = 3;
const BASELINE = { subgroupSize: SIZE, baselineSubgroups: 4 };

// Epoch changes rare in some universes and every few readings in others (runs cut short).
const universeArb = fc
  .integer({ min: 4, max: 40 })
  .chain((breaks) =>
    fc.array(
      fc.record({
        value: fc.oneof(
          { weight: 6, arbitrary: fc.integer({ min: 1990, max: 2010 }) },
          { weight: 2, arbitrary: fc.integer({ min: 2010, max: 2030 }) },
          { weight: 1, arbitrary: fc.integer({ min: 1500, max: 2600 }) },
        ),
        gap: fc.integer({ min: 0, max: 3 }),
        sameSeq: fc.integer({ min: 0, max: 15 }),
        epochBreak: fc.integer({ min: 0, max: breaks }),
        retest: fc.integer({ min: 0, max: 12 }),
      }),
      { minLength: 0, maxLength: 120, size: 'max' },
    ),
  )
  .map((items) => {
    let epoch = 1;
    let at = 0;
    let seq = 0;
    return items.map((item, i): Reading => {
      if (item.epochBreak === 0) epoch += 1;
      at += item.gap * 1000;
      // Now and then the same position as the reading before: told apart by key.
      if (item.sameSeq !== 0) seq += 1;
      return {
        key: `r${String(i).padStart(3, '0')}`,
        epoch,
        at,
        seq,
        pass: item.retest === 0 ? 2 : 1,
        value: item.value,
      };
    });
  });

const rulesArb: fc.Arbitrary<RuleSet> = fc.oneof(
  fc.constant(DEFAULT_RULES),
  fc.record({
    I: fc.subarray([...RULES]),
    MR: fc.subarray([1] as const),
    Xbar: fc.subarray([...RULES]),
    R: fc.subarray([1] as const),
  }),
);

type Op =
  | {
      readonly kind: 'deliver';
      readonly count: number;
      readonly salt: number;
      readonly holdBack: number;
      readonly release: boolean;
    }
  | { readonly kind: 'again'; readonly count: number; readonly salt: number }
  | { readonly kind: 'remove'; readonly pick: number; readonly count: number }
  | { readonly kind: 'change'; readonly pick: number; readonly what: number; readonly by: number }
  | { readonly kind: 'v1' }
  | { readonly kind: 'version'; readonly a: number; readonly b: number; readonly at: number }
  | { readonly kind: 'end'; readonly at: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant('deliver' as const),
      count: fc.integer({ min: 1, max: 25 }),
      salt: fc.nat(),
      holdBack: fc.integer({ min: 0, max: 3 }),
      release: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('again' as const),
      count: fc.integer({ min: 1, max: 10 }),
      salt: fc.nat(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('remove' as const),
      pick: fc.nat(),
      count: fc.integer({ min: 1, max: 3 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('change' as const),
      pick: fc.nat(),
      what: fc.integer({ min: 0, max: 2 }),
      by: fc.integer({ min: -40, max: 40 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('v1' as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('version' as const),
      a: fc.nat(),
      b: fc.nat(),
      at: fc.nat(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('end' as const), at: fc.nat() }) },
);

/** A position at or just after a held first-pass reading (a version's `from` or `until`). */
function positionAt(held: readonly Reading[], at: number): Position | null {
  const ordered = firstPass(held);
  if (ordered.length === 0) return null;
  const r = ordered[at % ordered.length];
  if (r === undefined) return null;
  return at % 2 === 0 ? { epoch: r.epoch, at: r.at, seq: r.seq } : { ...r, seq: r.seq + 1 };
}

/** Whether the update only appended first-pass readings after every earlier one. */
function appendedOnly(before: readonly Reading[], after: readonly Reading[]): boolean {
  const old = firstPass(before);
  const now = firstPass(after);
  if (now.length < old.length) return false;
  return old.every((r, i) => {
    const same = now[i];
    return same?.key === r.key && same.value === r.value && comparePositions(same, r) === 0;
  });
}

describe('spc-core incremental derivation', () => {
  it('equals the whole derivation after every change', () => {
    fc.assert(
      fc.property(
        universeArb,
        rulesArb,
        fc.array(opArb, { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 2, max: 5 }),
        (universe, rules, ops, size) => {
          const held = new Map<string, Reading>();
          let versions: LimitVersion[] = [];
          const derivation = new SpcDerivation({ rules, subgroupSize: size });
          // \`new\` exactly when the change only appended first-pass readings at the end.
          const expectKind = (before: readonly Reading[], kind: string): void => {
            expect(kind).toBe(appendedOnly(before, [...held.values()]) ? 'new' : 'late');
          };
          let cursor = 0;
          const withheld: Reading[] = [];
          const mix = <T>(items: readonly T[], salt: number): T[] =>
            items
              .map((item, i) => ({ item, k: (i * 7919 + salt) % 101 }))
              .sort((a, b) => a.k - b.k)
              .map(({ item }) => item);
          for (const op of ops) {
            const before = [...held.values()];
            let versionsChanged = false;
            switch (op.kind) {
              case 'deliver': {
                // The next readings of the universe in a random order, some held back for a later
                // batch (late: before readings delivered meanwhile), and those held back earlier.
                const next = mix(universe.slice(cursor, cursor + op.count), op.salt);
                cursor += op.count;
                withheld.push(...next.splice(0, op.holdBack));
                const batch = op.release ? [...next, ...withheld.splice(0)] : next;
                for (const r of batch) held.set(r.key, r);
                expectKind(before, derivation.update({ upsert: batch }).kind);
                break;
              }
              case 'again': {
                const batch = mix([...held.values()].slice(0, op.count), op.salt);
                const update = derivation.update({ upsert: batch });
                expect(update.kind).toBe('new');
                expect(update.from).toBe(update.before);
                break;
              }
              case 'remove': {
                const keys = [...held.keys()];
                const gone = keys.slice(
                  op.pick % (keys.length + 1),
                  (op.pick % (keys.length + 1)) + op.count,
                );
                for (const key of gone) held.delete(key);
                expectKind(before, derivation.update({ remove: gone }).kind);
                break;
              }
              case 'change': {
                const keys = [...held.keys()];
                const key = keys[op.pick % (keys.length + 1)];
                const old = key === undefined ? undefined : held.get(key);
                if (old === undefined) break;
                const changed: Reading =
                  op.what === 0
                    ? { ...old, value: old.value + op.by }
                    : op.what === 1
                      ? { ...old, at: Math.max(0, old.at + op.by * 1000) }
                      : { ...old, pass: old.pass === 1 ? 2 : 1 };
                held.set(changed.key, changed);
                // Now and then removed and upserted again in one change (as a part's rebuild).
                const update =
                  op.by % 2 === 0
                    ? derivation.update({ remove: [changed.key], upsert: [changed] })
                    : derivation.update({ upsert: [changed] });
                expectKind(before, update.kind);
                break;
              }
              case 'v1': {
                if (versions.length > 0) break;
                const v1 = firstVersion([...held.values()], {
                  subgroupSize: size,
                  baselineSubgroups: 4,
                });
                if (v1 === null) break;
                versions = [v1];
                versionsChanged = true;
                break;
              }
              case 'version': {
                const ordered = firstPass([...held.values()]);
                const from = positionAt([...held.values()], op.at);
                if (ordered.length === 0 || from === null) break;
                const a = ordered[op.a % ordered.length];
                const b = ordered[op.b % ordered.length];
                if (a === undefined || b === undefined) break;
                const [lo, hi] = comparePositions(a, b) <= 0 ? [a, b] : [b, a];
                let limits;
                try {
                  limits = estimateLimits(ordered, { from: lo, to: hi }, size);
                } catch {
                  break;
                }
                const at = from.at;
                // The newest open version ends where the new one starts (as the MES writes it).
                versions = versions.map((v) =>
                  v.until === null && v.version === versions.length
                    ? { ...v, until: from, endedAt: at }
                    : v,
                );
                versions = [
                  ...versions,
                  {
                    version: versions.length + 1,
                    createdAt: at,
                    from,
                    until: null,
                    endedAt: null,
                    limits,
                  },
                ];
                versionsChanged = true;
                break;
              }
              case 'end': {
                const open = versions.findLast((v) => v.until === null);
                const until = positionAt([...held.values()], op.at);
                if (open === undefined || until === null) break;
                versions = versions.map((v) =>
                  v === open ? { ...v, until, endedAt: until.at } : v,
                );
                versionsChanged = true;
                break;
              }
            }
            if (versionsChanged) {
              const update = derivation.update({ versions });
              expect(update.whole).toBe(true);
            }
            const whole = spcChart({
              readings: [...held.values()],
              versions,
              rules,
              subgroupSize: size,
            });
            expect(derivation.chart()).toEqual(whole);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('re-derives a new reading at the end from that reading and a late one from its place', () => {
    const readings: Reading[] = Array.from({ length: 60 }, (_, i) => ({
      key: `k${String(i).padStart(2, '0')}`,
      epoch: 1,
      at: i * 1000,
      seq: i,
      pass: 1,
      value: 2000 + ((i * 37) % 23),
    }));
    const v1 = firstVersion(readings.slice(0, 40), BASELINE);
    if (v1 === null) throw new Error('no version 1');
    const late = readings[20];
    const last = readings[59];
    if (late === undefined || last === undefined) throw new Error('no readings');
    const held = readings.filter((r) => r !== late && r !== last);
    const derivation = new SpcDerivation({
      rules: DEFAULT_RULES,
      subgroupSize: SIZE,
      versions: [v1],
      readings: held,
    });
    const appended = derivation.update({ upsert: [last] });
    expect(appended).toEqual({ before: 58, after: 59, from: 58, whole: false, kind: 'new' });
    const resumed = derivation.update({ upsert: [late] });
    expect(resumed).toEqual({ before: 59, after: 60, from: 20, whole: false, kind: 'late' });
    expect(derivation.update({ upsert: [late] })).toEqual({
      before: 60,
      after: 60,
      from: 60,
      whole: false,
      kind: 'new',
    });
    expect(derivation.chart()).toEqual(
      spcChart({ readings, versions: [v1], rules: DEFAULT_RULES, subgroupSize: SIZE }),
    );
    expect(derivation.get(late.key)).toBe(late);
    expect([...derivation.readings()]).toHaveLength(60);
    expect(derivation.versions).toEqual([v1]);
  });

  it('judges a kept point again when its rule window reaches a changed reading', () => {
    // Nine readings above the centre fire rule 2 at the ninth; a late change moves the first of
    // them below it, so the ninth no longer fires although it and the seven before it are kept.
    const baseline: Reading[] = Array.from({ length: 12 }, (_, i) => ({
      key: `b${String(i).padStart(2, '0')}`,
      epoch: 1,
      at: i,
      seq: i,
      pass: 1,
      value: i % 2 === 0 ? 1990 : 2010,
    }));
    const above: Reading[] = Array.from({ length: 9 }, (_, i) => ({
      key: `c${String(i)}`,
      epoch: 1,
      at: 12 + i,
      seq: 12 + i,
      pass: 1,
      value: 2005,
    }));
    const v1 = firstVersion(baseline, BASELINE);
    if (v1 === null) throw new Error('no version 1');
    const derivation = new SpcDerivation({
      rules: DEFAULT_RULES,
      subgroupSize: SIZE,
      versions: [v1],
      readings: [...baseline, ...above],
    });
    expect(derivation.chart().points.I.at(-1)?.rules).toContain(2);
    const first = above[0];
    if (first === undefined) throw new Error('no reading');
    const moved = { ...first, value: 1995 };
    expect(derivation.update({ upsert: [moved] }).kind).toBe('late');
    const readings = [...baseline, moved, ...above.slice(1)];
    expect(derivation.chart().points.I.at(-1)?.rules).not.toContain(2);
    expect(derivation.chart()).toEqual(
      spcChart({ readings, versions: [v1], rules: DEFAULT_RULES, subgroupSize: SIZE }),
    );
  });

  it('judges a kept point again when its run now starts at the first kept point', () => {
    // Epoch 2 opens with x and eight readings above the centre: rule 2 fires at the eighth (nine
    // in the run with x). Removing x makes the eight the whole run: the kept points' windows are
    // all kept points, but the run is one shorter, so rule 2 no longer fires.
    const baseline: Reading[] = Array.from({ length: 12 }, (_, i) => ({
      key: `b${String(i).padStart(2, '0')}`,
      epoch: 1,
      at: i,
      seq: i,
      pass: 1,
      value: i % 2 === 0 ? 1990 : 2010,
    }));
    const x: Reading = { key: 'x', epoch: 2, at: 100, seq: 0, pass: 1, value: 2005 };
    const above: Reading[] = Array.from({ length: 8 }, (_, i) => ({
      key: `s${String(i)}`,
      epoch: 2,
      at: 101 + i,
      seq: 1 + i,
      pass: 1,
      value: 2005,
    }));
    const v1 = firstVersion(baseline, BASELINE);
    if (v1 === null) throw new Error('no version 1');
    const derivation = new SpcDerivation({
      rules: DEFAULT_RULES,
      subgroupSize: SIZE,
      versions: [v1],
      readings: [...baseline, x, ...above],
    });
    expect(derivation.chart().points.I.at(-1)?.rules).toContain(2);
    expect(derivation.update({ remove: ['x'] }).kind).toBe('late');
    expect(derivation.chart().points.I.at(-1)?.rules).not.toContain(2);
    expect(derivation.chart()).toEqual(
      spcChart({
        readings: [...baseline, ...above],
        versions: [v1],
        rules: DEFAULT_RULES,
        subgroupSize: SIZE,
      }),
    );
    // Removed and upserted unchanged in one change: no change, nothing resumed.
    const last = above.at(-1);
    if (last === undefined) throw new Error('no reading');
    expect(derivation.update({ remove: [last.key], upsert: [last] })).toMatchObject({
      kind: 'new',
      from: 20,
    });
  });

  it('refuses what the whole derivation refuses', () => {
    expect(() => new SpcDerivation({ rules: DEFAULT_RULES, subgroupSize: 11 })).toThrow(RangeError);
    const derivation = new SpcDerivation({ rules: DEFAULT_RULES, subgroupSize: SIZE });
    expect(() =>
      derivation.update({ upsert: [{ key: 'x', epoch: 1, at: 0, seq: 0, pass: 1, value: 1.5 }] }),
    ).toThrow(RangeError);
    expect(() =>
      derivation.update({ upsert: [{ key: 'x', epoch: 1, at: 0, seq: 0, pass: 0, value: 1 }] }),
    ).toThrow(RangeError);
    const readings: Reading[] = Array.from({ length: 30 }, (_, i) => ({
      key: `k${String(i)}`,
      epoch: 1,
      at: i,
      seq: i,
      pass: 1,
      value: 2000 + (i % 7),
    }));
    const v1 = firstVersion(readings, { subgroupSize: 5, baselineSubgroups: 2 });
    if (v1 === null) throw new Error('no version 1');
    expect(() => derivation.update({ versions: [v1] })).toThrow(/subgroups of 5/);
  });
});
