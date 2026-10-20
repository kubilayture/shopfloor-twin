import { describe, expect, it } from 'vitest';
import {
  BOTTLENECKS,
  ORDER_LINE,
  bucket,
  emptyResult,
  lineBucket,
  orderOee,
  result,
} from '../test/oee-fixtures.ts';
import {
  bottleneckMachines,
  bucketFlags,
  cycleText,
  goodText,
  lineFlags,
  orderFlags,
  orderLineFlags,
  orderPending,
  pickOrderOee,
  minutesText,
  parseFraction,
  percentText,
  pickBucket,
  ratioText,
  secondsText,
  waterfall,
} from './oee.ts';
import { fraction } from '@shopfloor/oee-core';

describe('ratio text', () => {
  it('shows the API decimal as sent and null as n/a, never 0', () => {
    expect(ratioText({ fraction: '63/100', decimal: '0.6300' })).toBe('0.6300');
    expect(ratioText(null)).toBe('n/a');
    expect(percentText(null)).toBe('n/a');
  });

  it('turns four decimals into a percentage by moving the point', () => {
    expect(percentText({ fraction: '', decimal: '0.8193' })).toBe('81.93 %');
    expect(percentText({ fraction: '', decimal: '1.0421' })).toBe('104.21 %');
    expect(percentText({ fraction: '', decimal: '0.0000' })).toBe('0.00 %');
    expect(percentText({ fraction: '', decimal: '0.0050' })).toBe('0.50 %');
    expect(percentText({ fraction: '', decimal: 'odd' })).toBe('odd');
  });

  it('formats exact ms as minutes rounded half-up', () => {
    expect(minutesText(90_000)).toBe('1.5 min');
    expect(minutesText(fraction(3_000n, 1n))).toBe('0.1 min');
    expect(minutesText(parseFraction('14/3'))).toBe('0.0 min');
    expect(() => parseFraction('1.5')).toThrow(RangeError);
  });

  it('formats exact ms as seconds for the waterfall tooltips', () => {
    expect(secondsText(parseFraction('820000/3'))).toBe('273.333 s');
    expect(secondsText(fraction(1_234n))).toBe('1.234 s');
  });
});

describe('loss waterfall', () => {
  it('takes every step from the API and lands exactly on OEE × PBT', () => {
    const steps = waterfall(result());
    expect(steps?.consistent).toBe(true);
    expect(
      steps?.steps.map((step) => [step.key, step.kind, minutesText(step.ms), step.from, step.to]),
    ).toEqual([
      ['pbt', 'total', '16.7 min', 0, 1_000_000],
      ['own', 'loss', '2.5 min', 850_000, 1_000_000],
      ['external', 'loss', '0.8 min', 800_000, 850_000],
      ['apt', 'total', '13.3 min', 0, 800_000],
      ['micro', 'loss', '0.7 min', 760_000, 800_000],
      ['speed', 'loss', '1.0 min', 700_000, 760_000],
      ['quality', 'loss', '1.2 min', 630_000, 700_000],
      ['productive', 'total', '10.5 min', 0, 630_000],
    ]);
  });

  it('draws negative speed loss (P > 1) as a gain and keeps fractional quality loss exact', () => {
    const base = result();
    const losses = base.losses;
    if (!losses) throw new Error('fixture has losses');
    // ideal 820 000 > APT − micro-stops: speed −60 000; 2 good of 3: quality loss 820 000 / 3.
    const steps = waterfall({
      ...base,
      oee: { fraction: '41/75', decimal: '0.5467' },
      totals: { ...base.totals, idealMs: 820_000, good: 2, produced: 3 },
      losses: {
        ...losses,
        performance: { microStops: 40_000, speed: -60_000, total: -20_000 },
        quality: { fraction: '820000/3', decimal: '273333.3333' },
      },
    });
    expect(steps?.consistent).toBe(true);
    const speed = steps?.steps.find((step) => step.key === 'speed');
    expect(speed?.kind).toBe('gain');
    expect(speed && [speed.from, speed.to]).toEqual([760_000, 820_000]);
    const productive = steps?.steps.at(-1);
    // 820 000 − 820 000/3 = 1 640 000/3 = 0.5467 × 1 000 000 exactly as 41/75 × PBT.
    expect(productive && `${String(productive.ms.num)}/${String(productive.ms.den)}`).toBe(
      '1640000/3',
    );
  });

  it('says when the losses do not add up', () => {
    const base = result();
    expect(
      waterfall({ ...base, totals: { ...base.totals, actualProductionMs: 799_999 } })?.consistent,
    ).toBe(false);
    expect(waterfall({ ...base, oee: { fraction: '64/100', decimal: '0.6400' } })?.consistent).toBe(
      false,
    );
  });

  it('has no waterfall without planned busy time', () => {
    expect(waterfall(emptyResult())).toBeNull();
  });
});

describe('bucket status', () => {
  it('names final, provisional, revision, incidents and anomaly in text', () => {
    expect(bucketFlags(bucket('cell-m1', { final: true })).map((flag) => flag.text)).toEqual([
      'Final',
    ]);
    expect(
      bucketFlags(
        bucket('cell-m1', {
          revision: 2,
          incidents: 1,
          result: { ...result(), anomaly: true },
        }),
      ).map((flag) => flag.text),
    ).toEqual(['Provisional (2.0 min)', 'Revision 2', '1 incident', 'Anomaly']);
    expect(bucketFlags(bucket('cell-m1', { incidents: 3 }))[1]?.text).toBe('3 incidents');
  });

  it('prefers a pushed bucket unless the REST one is further along', () => {
    const rest = bucket('cell-m1');
    const pushed = bucket('cell-m1', { provisionalMs: 1 });
    expect(pickBucket(rest, undefined)).toBe(rest);
    expect(pickBucket(undefined, pushed)).toBe(pushed);
    expect(pickBucket(rest, pushed)).toBe(pushed);
    const final = bucket('cell-m1', { final: true });
    expect(pickBucket(final, pushed)).toBe(final);
    const revised = bucket('cell-m1', { revision: 1 });
    expect(pickBucket(revised, pushed)).toBe(revised);
    // A push of a higher revision wins whole, over a final REST bucket of a lower one (#257 A1).
    const newer = bucket('cell-m1', { provisionalMs: 1, revision: 2 });
    expect(pickBucket(final, newer)).toBe(newer);
    expect(pickBucket(bucket('cell-m1', { final: true, revision: 1 }), newer)).toBe(newer);
  });

  it('drops a final line bucket of an older plant epoch for the push, and keeps a newer one (#257)', () => {
    const withdrawn = lineBucket('hour', '2026-10-12T05:00:00.000Z', { final: true, epoch: 1 });
    const pushed = lineBucket('hour', '2026-10-12T05:00:00.000Z', { final: false, epoch: 2 });
    expect(pickBucket(withdrawn, pushed)).toBe(pushed);
    // A REST answer of a newer epoch over an older push.
    const restNewer = lineBucket('hour', '2026-10-12T05:00:00.000Z', { final: false, epoch: 3 });
    expect(pickBucket(restNewer, pushed)).toBe(restNewer);
    // Within one epoch, as before: a final REST bucket over a provisional push.
    const sameEpoch = lineBucket('hour', '2026-10-12T05:00:00.000Z', { final: true, epoch: 2 });
    expect(pickBucket(sameEpoch, pushed)).toBe(sameEpoch);
    // No epoch on either side (no plant clock): the flag rule.
    expect(pickBucket({ ...withdrawn, epoch: null }, pushed)).toEqual({
      ...withdrawn,
      epoch: null,
    });
  });
});

describe('order and line OEE (#233)', () => {
  it('names the MES’s bottleneck machines with their products', () => {
    const machines = bottleneckMachines([
      ...BOTTLENECKS,
      {
        product: 'VB-300',
        operation: 'OP10',
        equipment: ['cnc-01', 'cnc-02'],
        idealCycleMs: 400_000,
        effectiveCycleMs: '200000/1',
      },
    ]);
    expect([...machines]).toEqual([
      ['asm-01', ['VB-100', 'VB-200']],
      ['cnc-01', ['VB-300']],
      ['cnc-02', ['VB-300']],
    ]);
    expect(bottleneckMachines([]).size).toBe(0);
  });

  it('formats cycles and packed units', () => {
    expect(cycleText('150000/1')).toBe('150.000 s');
    expect(cycleText('330000/2')).toBe('165.000 s');
    expect(goodText({ 'VB-200': 3, 'VB-100': 12, 'VB-300': 0 })).toBe('VB-100 12 · VB-200 3');
    expect(goodText({})).toBe('none');
  });

  it('flags a line bucket: final or provisional, revision, incidents, above 1', () => {
    expect(lineFlags(lineBucket('shift', '2026-10-15/A')).map((f) => f.key)).toEqual([
      'provisional',
    ]);
    const flags = lineFlags(
      lineBucket('shift', '2026-10-15/A', {
        final: true,
        revision: 2,
        incidents: [{ machine: 'asm-01', epoch: 1, id: 1, seqFrom: 1, seqTo: 2 }],
        mayRevise: true,
        aboveOne: true,
      }),
    );
    expect(flags.map((f) => [f.key, f.text])).toEqual([
      ['final', 'Final'],
      ['revision', 'Revision 2'],
      ['incidents', '1 incident'],
      ['may-revise', 'May be revised'],
      ['above-one', 'Above 1'],
    ]);
    expect(flags.find((f) => f.key === 'above-one')?.title).toContain('not capped');
  });

  it('says why an order OEE is provisional, and never final on a lost path', () => {
    expect(orderPending(orderOee('PO-1'))).toEqual([]);
    expect(orderFlags(orderOee('PO-1')).map((f) => f.key)).toEqual(['final']);
    const open = orderOee('PO-1', { final: false, open: true, pending: true });
    expect(orderPending(open)).toEqual(['a job window is still open', 'a job has no window yet']);
    const lost = orderOee('PO-1', {
      final: false,
      lost: true,
      headTimeUnknown: true,
      endLost: true,
    });
    expect(orderFlags(lost)[0]?.text).toBe('Never final');
    expect(orderPending(lost)).toHaveLength(3);
    expect(orderPending(orderOee('PO-1', { final: false }))).toEqual([
      'its inputs are not final yet',
    ]);
    const line = ORDER_LINE;
    expect(orderLineFlags({ ...line, final: false, open: true })[0]?.text).toBe(
      'Provisional (order in progress)',
    );
    expect(orderLineFlags({ ...line, final: false })[0]?.text).toBe('Provisional');
    expect(orderLineFlags({ ...line, aboveOne: true }).map((f) => f.key)).toEqual([
      'final',
      'above-one',
    ]);
  });

  it('picks the pushed order OEE unless REST is further along', () => {
    const rest = orderOee('PO-1');
    const pushed = orderOee('PO-1', { final: false });
    expect(pickOrderOee(rest, undefined)).toBe(rest);
    expect(pickOrderOee(rest, null)).toBe(rest);
    expect(pickOrderOee(undefined, pushed)).toBe(pushed);
    expect(pickOrderOee(rest, pushed)).toBe(rest);
    const revised = orderOee('PO-1', { revision: 1 });
    expect(pickOrderOee(revised, rest)).toBe(revised);
    expect(pickOrderOee(rest, revised)).toBe(revised);
    // A push of a higher revision wins whole, even over REST parts final where its own are not
    // (#257 A1): a final REST part of a lower revision is older.
    const newer = orderOee('PO-1', {
      final: false,
      revision: 2,
      line: { ...ORDER_LINE, final: false, open: true },
      firstPassYield: { ...rest.firstPassYield, final: false },
    });
    expect(pickOrderOee(rest, newer)).toBe(newer);
    expect(pickOrderOee(revised, newer)).toBe(newer);
  });

  it('keeps each final part of the REST answer: a push final for the order but not its line', () => {
    const rest = orderOee('PO-1');
    const pushed = orderOee('PO-1', {
      oee: result({ oee: { fraction: '1/2', decimal: '0.5000' } }),
      line: { ...ORDER_LINE, final: false, open: true },
      firstPassYield: { ...rest.firstPassYield, final: false },
    });
    const shown = pickOrderOee(rest, pushed);
    // The order part from the push (both final), the line and the yield from REST (final there).
    expect(shown?.oee.oee?.decimal).toBe('0.5000');
    expect(shown?.line).toEqual(ORDER_LINE);
    expect(shown?.firstPassYield.final).toBe(true);
    // And the other way round: the push's final line over a provisional REST line.
    const restOpen = orderOee('PO-1', { line: { ...ORDER_LINE, final: false } });
    expect(pickOrderOee(restOpen, rest)).toBe(rest);
    const pushedOpen = orderOee('PO-1', { final: false, line: ORDER_LINE });
    const mixed = pickOrderOee(
      orderOee('PO-1', { line: { ...ORDER_LINE, final: false } }),
      pushedOpen,
    );
    expect(mixed?.final).toBe(true);
    expect(mixed?.line?.final).toBe(true);
  });
});
