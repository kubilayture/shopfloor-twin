import { describe, expect, it } from 'vitest';
import { bucket, emptyResult, result } from '../test/oee-fixtures.ts';
import {
  bucketFlags,
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
  });
});
