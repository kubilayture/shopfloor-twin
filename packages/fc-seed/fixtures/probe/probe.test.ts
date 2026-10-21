// A probe property for `src/reproduce.test.ts`: records the values fast-check generated in this run
// to the file `FC_PROBE_OUT` names.
import { writeFileSync } from 'node:fs';
import fc from 'fast-check';
import { expect, test } from 'vitest';

export interface ProbeRecord {
  /** fast-check's global seed in the worker. */
  globalSeed: unknown;
  /** The first values an `fc.assert` without a seed generated. */
  asserted: number[];
  /** `fc.sample` without a seed. */
  sampled: number[];
  /** `fc.sample` with an explicit seed (156, as `alarm-writes.test.ts` uses). */
  explicit: number[];
}

test('probe property', () => {
  const asserted: number[] = [];
  fc.assert(
    fc.property(fc.integer(), (value) => {
      if (asserted.length < 10) asserted.push(value);
    }),
  );
  const record: ProbeRecord = {
    globalSeed: fc.readConfigureGlobal().seed,
    asserted,
    sampled: fc.sample(fc.integer(), 10),
    explicit: fc.sample(fc.integer(), { numRuns: 10, seed: 156 }),
  };
  const out = process.env.FC_PROBE_OUT;
  expect(out).toBeDefined();
  writeFileSync(out ?? '', JSON.stringify(record));
});
