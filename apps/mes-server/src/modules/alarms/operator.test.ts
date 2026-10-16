import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { unshelvePlantTime } from './lifecycle.ts';
import {
  measuredFrom,
  operatorMeasures,
  type OperatorBucketDef,
  type OperatorOccurrence,
} from './operator.ts';
import type { EndReason } from './tables.ts';

const EPOCH = 7;

const occurrenceArb: fc.Arbitrary<OperatorOccurrence> = fc
  .record({
    equipment: fc.constantFrom('cnc-01', 'cnc-02'),
    code: fc.constantFrom('A', 'B'),
    raisedAt: fc.integer({ min: 0, max: 20 }),
    end: fc.option(
      fc.record({
        after: fc.integer({ min: 0, max: 12 }),
        reason: fc.constantFrom<EndReason>('cleared', 'lost', 'superseded', 'epoch-ended'),
      }),
    ),
    ack: fc.option(
      fc.record({
        after: fc.option(fc.integer({ min: 0, max: 12 })),
        epoch: fc.constantFrom(EPOCH, EPOCH + 1),
      }),
    ),
  })
  .map(({ equipment, code, raisedAt, end, ack }) => {
    const ackAfter = ack?.after ?? null;
    return {
      equipment,
      code,
      raisedAt,
      endedAt: end === null ? null : raisedAt + end.after,
      endReason: end === null ? null : end.reason,
      ackPlantAt: ackAfter === null ? null : raisedAt + ackAfter,
      ackPlantEpoch: ackAfter === null ? null : (ack?.epoch ?? null),
    };
  });

/** Contiguous buckets from `start`, and the earliest bucket start the query is bounded by. */
const bucketsArb = fc
  .record({
    start: fc.integer({ min: 0, max: 20 }),
    below: fc.integer({ min: 0, max: 2 }),
    widths: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 5 }),
    clock: fc.integer({ min: 1, max: 16 }),
  })
  .map(({ start, below, widths, clock }) => {
    const defs: OperatorBucketDef[] = [];
    let from = start;
    for (const [i, width] of widths.entries()) {
      defs.push({ key: String(i), from, to: from + width });
      from += width;
    }
    const asOf = start + clock;
    // As the module does: only buckets that have started at the plant clock.
    return { defs: defs.filter((def) => def.from < asOf), first: start - below, asOf };
  });

describe('the bounded operator measures query (#156)', () => {
  it('drops only occurrences that change no bucket: equal to the unbounded computation', () => {
    fc.assert(
      fc.property(
        fc.array(occurrenceArb, { maxLength: 60 }),
        bucketsArb,
        (occurrences, { defs, first, asOf }) => {
          const bounded = occurrences.filter((o) => measuredFrom(o, EPOCH, first));
          expect(operatorMeasures(bounded, [], EPOCH, asOf, defs)).toEqual(
            operatorMeasures(occurrences, [], EPOCH, asOf, defs),
          );
        },
      ),
      { numRuns: 5_000 },
    );
  });

  it('keeps what can count: a raise from `first` on, an open or late-acknowledged earlier one', () => {
    const base: OperatorOccurrence = {
      equipment: 'cnc-01',
      code: 'A',
      raisedAt: 50,
      endedAt: null,
      endReason: null,
      ackPlantAt: null,
      ackPlantEpoch: null,
    };
    const cases: [Partial<OperatorOccurrence>, boolean][] = [
      [{ raisedAt: 100 }, true],
      [{}, true],
      [{ ackPlantAt: 100, ackPlantEpoch: EPOCH }, false],
      [{ ackPlantAt: 101, ackPlantEpoch: EPOCH }, true],
      [{ ackPlantAt: 20, ackPlantEpoch: EPOCH + 1 }, true],
      [{ endedAt: 100, endReason: 'epoch-ended' }, false],
      [{ endedAt: 101, endReason: 'epoch-ended' }, true],
      [{ endedAt: 60, endReason: 'cleared' }, true],
    ];
    for (const [change, kept] of cases) {
      expect([change, measuredFrom({ ...base, ...change }, EPOCH, 100)]).toEqual([change, kept]);
    }
  });
});

describe("an unshelve's plant time (#156)", () => {
  const clock = { epoch: 2, watermark: new Date(500) };
  const shelf = (epoch: number | null, until: number | null) => ({
    plant_epoch: epoch,
    until: until === null ? null : new Date(until),
  });
  const watermarks = new Map([[1, new Date(300)]]);
  const watermarkOf = (epoch: number) => watermarks.get(epoch);

  it("is the plant clock for a shelf of the clock's epoch", () => {
    expect(unshelvePlantTime(shelf(2, 900), clock, watermarkOf)).toEqual({
      epoch: 2,
      at: new Date(500),
    });
    expect(unshelvePlantTime(shelf(null, null), clock, watermarkOf)).toEqual({
      epoch: 2,
      at: new Date(500),
    });
    expect(unshelvePlantTime(shelf(2, 900), undefined, watermarkOf)).toEqual({
      epoch: 2,
      at: null,
    });
  });

  it("is the shelf's own epoch at its last plant time, never past until, once a newer epoch began", () => {
    expect(unshelvePlantTime(shelf(1, 900), clock, watermarkOf)).toEqual({
      epoch: 1,
      at: new Date(300),
    });
    expect(unshelvePlantTime(shelf(1, 250), clock, watermarkOf)).toEqual({
      epoch: 1,
      at: new Date(250),
    });
    // The old epoch's clock is unknown: in its epoch, at no plant time (closed at until or the
    // operator measures' own clock).
    expect(unshelvePlantTime(shelf(0, 900), clock, watermarkOf)).toEqual({ epoch: 0, at: null });
    expect(unshelvePlantTime(shelf(1, 900), clock, undefined)).toEqual({ epoch: 1, at: null });
  });
});
