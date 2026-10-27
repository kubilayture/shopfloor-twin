import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../api/client.ts';
import {
  ACK,
  alarmConfig,
  hourKpi,
  kpiBucket,
  occurrence,
  point,
  shelf,
} from '../test/alarm-fixtures.ts';
import {
  acknowledgeable,
  alarmBucketFlags,
  alarmShiftHours,
  endReasonText,
  isBehind,
  meanTimeToAck,
  mergeAlarms,
  msText,
  newerOccurrence,
  newerPoint,
  newerShelf,
  parseScopeKey,
  partition,
  durationLabel,
  floodText,
  rateBand,
  rateBandText,
  shelvePresets,
  scopeKey,
  shelfFailure,
  stateText,
  viewOf,
} from './alarms.ts';

const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

describe('alarm partition', () => {
  it('puts each state in the view the API partitions it into', () => {
    expect(viewOf(occurrence(1), false)).toBe('active');
    // A clear does not acknowledge: a cleared, unacknowledged alarm stays active (ISA-18.2).
    expect(
      viewOf(
        occurrence(1, { state: 'unacked-cleared', endedAt: '2026-10-15T05:10:00.000Z' }),
        false,
      ),
    ).toBe('active');
    expect(viewOf(occurrence(1, { state: 'acked-active', acknowledged: ACK }), false)).toBe(
      'acknowledged',
    );
    expect(viewOf(occurrence(1), true)).toBe('shelved');
    expect(viewOf(occurrence(1, { state: 'acked-active', acknowledged: ACK }), true)).toBe(
      'shelved',
    );
    // Closed goes to history, shelved or not.
    expect(viewOf(occurrence(1, { state: 'closed' }), true)).toBe('history');
  });

  it('takes the shelf from the versioned point over the occurrence copy', () => {
    const raised = occurrence(1, { shelved: false });
    const set = mergeAlarms(
      [[raised]],
      [point({ shelf: shelf({ shelved: true, version: 1 }) })],
      undefined,
    );
    expect(ids(partition(set).shelved)).toEqual([raised.id]);
    // A newer push of the point (higher version) unshelves it again.
    const live = {
      occurrences: {},
      points: { 'cnc-01/COOLANT-PRESSURE': point({ shelf: shelf({ version: 2 }) }) },
      seq: 1,
    };
    expect(ids(partition(mergeAlarms([[raised]], [...set.points.values()], live)).active)).toEqual([
      raised.id,
    ]);
    // An older one (lower version) does not.
    const older = { ...live, points: { 'cnc-01/COOLANT-PRESSURE': point() } };
    expect(
      ids(partition(mergeAlarms([[raised]], [...set.points.values()], older)).shelved),
    ).toEqual([raised.id]);
  });

  it('lists newest raise first in each view', () => {
    const set = mergeAlarms([[occurrence(1), occurrence(3)], [occurrence(2)]], [], undefined);
    expect(partition(set).active.map((item) => item.seq)).toEqual([3, 2, 1]);
  });
});

describe('live merge (monotonic upserts by id)', () => {
  const raised = occurrence(5);
  const acked = occurrence(5, { state: 'acked-active', acknowledged: ACK });
  const cleared = occurrence(5, {
    state: 'unacked-cleared',
    endedAt: '2026-10-15T05:30:00.000Z',
    endReason: 'cleared',
    active: false,
  });
  const closed = { ...cleared, state: 'closed' as const, acknowledged: ACK };

  it('never lets a copy without a step the known one took replace it', () => {
    expect(isBehind(raised, acked)).toBe(true);
    expect(isBehind(raised, cleared)).toBe(true);
    expect(isBehind(acked, closed)).toBe(true);
    expect(isBehind(raised, { ...raised, comments: 1 })).toBe(true);
    expect(isBehind(raised, { ...raised, final: true })).toBe(true);
    expect(isBehind(acked, raised)).toBe(false);
    // Each lacks a step of the other (a stale answer racing a push): neither dominates.
    expect(isBehind(acked, cleared)).toBe(true);
    expect(isBehind(cleared, acked)).toBe(true);
  });

  it('keeps the newer copy, and the incoming one at a tie or when neither dominates', () => {
    expect(newerOccurrence(acked, raised)).toBe(acked);
    expect(newerOccurrence(raised, acked)).toBe(acked);
    const relabelled = { ...raised, priority: 'high' as const };
    expect(newerOccurrence(raised, relabelled)).toBe(relabelled);
    expect(newerOccurrence(acked, cleared)).toBe(cleared);
    expect(newerOccurrence(cleared, acked)).toBe(acked);
  });

  it('takes a priority change and a late clear that replaces a lost end', () => {
    const lost = { ...cleared, endReason: 'lost' as const };
    const realClear = {
      ...lost,
      endedAt: '2026-10-15T05:20:00.000Z',
      endReason: 'cleared' as const,
    };
    expect(newerOccurrence(lost, realClear)).toBe(realClear);
    const reprioritised = { ...realClear, priority: 'high' as const };
    expect(newerOccurrence(realClear, reprioritised)).toBe(reprioritised);
  });

  it('explains a body the request schema refused, briefly', () => {
    const parsed = z.object({ reason: z.string().min(1) }).safeParse({ reason: '' });
    if (parsed.success) throw new Error('expected a refusal');
    const failure = shelfFailure(parsed.error, 'shelve');
    expect(failure.kind).toBe('invalid');
    expect(failure.text).toMatch(/^Not shelved: check the form \(reason: /);
    expect(failure.text).not.toContain('"code"');
  });

  it('merges a late REST answer under the live upsert (REST read before the push)', () => {
    const live = { occurrences: { [acked.id]: acked }, points: {}, seq: 1 };
    const set = mergeAlarms([[raised]], [], live);
    expect(set.occurrences).toEqual([acked]);
    // A REST read after the push that is further along (closed) wins over it.
    const later = mergeAlarms([[closed]], [], live);
    expect(later.occurrences).toEqual([closed]);
    expect(partition(later).history).toEqual([closed]);
    // A push of an occurrence the REST lists don't hold joins them.
    const joined = mergeAlarms([[occurrence(1)]], [], live);
    expect(ids(partition(joined).acknowledged)).toEqual([acked.id]);
    expect(ids(partition(joined).active)).toEqual([occurrence(1).id]);
  });

  it('orders shelves and points by version', () => {
    const one = point({ shelf: shelf({ version: 1, shelved: true }) });
    const two = point({ shelf: shelf({ version: 2 }) });
    expect(newerPoint(two, one)).toBe(two);
    expect(newerPoint(one, two)).toBe(two);
    expect(newerShelf(one.shelf, two.shelf)).toBe(two.shelf);
    expect(newerShelf(two.shelf, one.shelf)).toBe(two.shelf);
    expect(newerShelf(undefined, one.shelf)).toBe(one.shelf);
    expect(newerShelf(one.shelf, undefined)).toBe(one.shelf);
  });
});

describe('alarm text', () => {
  it('says the state, the end and whether it can be acknowledged', () => {
    expect(stateText(occurrence(1))).toBe('Active, unacknowledged');
    expect(stateText(occurrence(1, { state: 'unacked-cleared' }))).toBe('Cleared, unacknowledged');
    expect(stateText(occurrence(1, { state: 'acked-active' }))).toBe('Active, acknowledged');
    expect(stateText(occurrence(1, { state: 'closed' }))).toBe('Closed');
    expect(endReasonText('lost')).toContain('resync');
    expect(endReasonText('superseded')).toContain('next raise');
    expect(endReasonText('epoch-ended')).toContain('run');
    expect(endReasonText('cleared')).toContain('device');
    expect(endReasonText(null)).toBe('still active');
    expect(acknowledgeable(occurrence(1))).toBe(true);
    expect(acknowledgeable(occurrence(1, { state: 'unacked-cleared' }))).toBe(true);
    expect(acknowledgeable(occurrence(1, { acknowledged: ACK, state: 'acked-active' }))).toBe(
      false,
    );
    expect(acknowledgeable(occurrence(1, { state: 'closed' }))).toBe(false);
  });

  it('caps the shelving presets at the served maxShelveMs, and offers the limit itself', () => {
    const labels = (maxShelveMs: number) =>
      shelvePresets(alarmConfig({ maxShelveMs })).map((preset) => preset.label);
    expect(labels(8 * 3_600_000)).toEqual(['15 min', '1 h', '4 h', '8 h']);
    expect(labels(2 * 3_600_000)).toEqual(['15 min', '1 h', '2 h']);
    expect(labels(12 * 3_600_000)).toEqual(['15 min', '1 h', '4 h', '8 h', '12 h']);
    expect(labels(10 * 60_000)).toEqual(['10 min']);
    expect(shelvePresets(alarmConfig({ maxShelveMs: 90 * 60_000 })).map((p) => p.ms)).toEqual([
      900_000, 3_600_000, 5_400_000,
    ]);
    expect([durationLabel(3_600_000), durationLabel(90_000), durationLabel(1_500)]).toEqual([
      '1 h',
      '90 s',
      '1.5 s',
    ]);
  });

  it('explains a shelf conflict and the other refusals', () => {
    const conflict = shelfFailure(new ApiError('x', 409), 'shelve');
    expect(conflict.kind).toBe('conflict');
    expect(conflict.text).toMatch(/^Not shelved: the point's shelf changed/);
    expect(shelfFailure(new ApiError('x', 422, undefined), 'unshelve').text).toMatch(
      /^Not unshelved: the MES cannot apply this unshelve \(422/,
    );
    expect(shelfFailure(new ApiError('x', 405), 'shelve').kind).toBe('refused');
    expect(shelfFailure(new Error('bad body'), 'shelve')).toEqual({
      kind: 'invalid',
      text: 'bad body',
    });
  });
});

describe('alarm KPIs', () => {
  it('compares the average rate with the served benchmarks exactly', () => {
    const config = alarmConfig();
    expect(rateBand({ fraction: '1/1', decimal: '1.0000' }, config)).toBe('acceptable');
    expect(rateBand({ fraction: '1000001/1000000', decimal: '1.0000' }, config)).toBe('manageable');
    expect(rateBand({ fraction: '2/1', decimal: '2.0000' }, config)).toBe('manageable');
    expect(rateBand({ fraction: '49/24', decimal: '2.0417' }, config)).toBe('over');
    expect(rateBand({ fraction: '0/1', decimal: '0.0000' }, config)).toBe('acceptable');
    expect(rateBandText('over', config)).toBe('Over the benchmark (> 2 per 10 min)');
  });

  it('follows changed benchmarks and a window other than 10 minutes (#160)', () => {
    const wider = alarmConfig({ benchmarks: { acceptablePer10Min: 2, manageablePer10Min: 4 } });
    expect(rateBand({ fraction: '2/1', decimal: '2.0000' }, wider)).toBe('acceptable');
    expect(rateBand({ fraction: '3/1', decimal: '3.0000' }, wider)).toBe('manageable');
    expect(rateBandText('acceptable', wider)).toBe('Acceptable (≤ 2 per 10 min)');
    expect(rateBandText('manageable', wider)).toBe('Manageable (≤ 4 per 10 min)');
    // A 5-minute window: 1 per window is 2 per 10 minutes.
    const five = alarmConfig({ kpi: { windowMs: 300_000 } });
    expect(rateBand({ fraction: '1/2', decimal: '0.5000' }, five)).toBe('acceptable');
    expect(rateBand({ fraction: '1/1', decimal: '1.0000' }, five)).toBe('manageable');
    expect(rateBand({ fraction: '11/10', decimal: '1.1000' }, five)).toBe('over');
    expect(floodText(14, five.kpi)).toBe('Up to 14 raises in 5 min (more than 10 is a flood)');
    expect(floodText(9, alarmConfig({ kpi: { floodThreshold: 8 } }).kpi)).toBe(
      'Up to 9 raises in 10 min (more than 8 is a flood)',
    );
  });

  it('flags final, provisional, revision and incidents as text', () => {
    expect(alarmBucketFlags(kpiBucket()).map((flag) => flag.text)).toEqual(['Provisional']);
    expect(alarmBucketFlags(kpiBucket({ fleetingUndecided: 2 })).map((flag) => flag.text)).toEqual([
      'Provisional (2 fleeting undecided)',
    ]);
    expect(
      alarmBucketFlags(
        kpiBucket({ final: true, provisional: false, revision: 2, incidents: 1 }),
      ).map((flag) => flag.text),
    ).toEqual(['Final', 'Revision 2', '1 incident']);
    expect(alarmBucketFlags(kpiBucket({ incidents: 3 })).at(-1)?.text).toBe('3 incidents');
    expect(alarmBucketFlags(kpiBucket({ provisional: false }))[0]?.title).toContain(
      'not yet final',
    );
  });

  it('shows times exactly and n/a where there is nothing', () => {
    expect(msText(90_000)).toBe('1.5 min');
    expect(msText(null)).toBe('n/a');
    expect(meanTimeToAck({ count: 0, sumMs: 0, maxMs: null })).toBe('n/a');
    // 100 000 ms / 3 = 33 333.3… ms = 0.5555… min → 0.6 min (half-up, exact).
    expect(meanTimeToAck({ count: 3, sumMs: 100_000, maxMs: 60_000 })).toBe('0.6 min');
  });

  it('names scopes as topics and search parameters do', () => {
    expect(scopeKey({ scope: 'plant', id: 'plant' })).toBe('plant');
    expect(scopeKey({ scope: 'position', id: 'cell-m1' })).toBe('position:cell-m1');
    expect(parseScopeKey('equipment:cnc-01')).toEqual({ scope: 'equipment', id: 'cnc-01' });
    expect(parseScopeKey('plant')).toEqual({ scope: 'plant', id: 'plant' });
    expect(parseScopeKey('work-center:x')).toBeUndefined();
    expect(parseScopeKey(undefined)).toBeUndefined();
  });
});

describe('alarmShiftHours (UX-4b, #325)', () => {
  const at = (iso: string) => Date.parse(iso);
  const shift = { from: at('2026-10-15T03:00:00.000Z'), to: at('2026-10-15T11:00:00.000Z') };
  const keys = (rows: ReturnType<typeof alarmShiftHours>) =>
    rows.map((row) => `${row.key.slice(11, 16)}${row.bucket ? '' : ' quiet'}`);

  it('lists every hour begun by the plant clock, the MES buckets in their place', () => {
    const rows = alarmShiftHours(
      [hourKpi('2026-10-15T04:00:00.000Z'), hourKpi('2026-10-15T06:00:00.000Z')],
      shift,
      at('2026-10-15T06:10:00.000Z'),
    );
    expect(keys(rows)).toEqual(['03:00 quiet', '04:00', '05:00 quiet', '06:00']);
    expect(rows[0]).toEqual({
      key: '2026-10-15T03:00:00.000Z',
      from: '2026-10-15T03:00:00.000Z',
      to: '2026-10-15T04:00:00.000Z',
      bucket: undefined,
    });
    // The hour the clock is in has begun, even exactly on its start; the next has not.
    expect(keys(alarmShiftHours([], shift, at('2026-10-15T05:00:00.000Z')))).toEqual([
      '03:00 quiet',
      '04:00 quiet',
      '05:00 quiet',
    ]);
  });

  it('stops at the shift end, keeps a bucket outside the hours and fills nothing without a clock', () => {
    expect(alarmShiftHours([], shift, at('2026-10-16T00:00:00.000Z'))).toHaveLength(8);
    expect(keys(alarmShiftHours([], shift, at('2026-10-16T00:00:00.000Z'))).at(-1)).toBe(
      '10:00 quiet',
    );
    // A bucket the MES listed is never dropped, even past the clock's hour.
    expect(
      keys(
        alarmShiftHours(
          [hourKpi('2026-10-15T09:00:00.000Z')],
          shift,
          at('2026-10-15T03:30:00.000Z'),
        ),
      ),
    ).toEqual(['03:00 quiet', '09:00']);
    expect(keys(alarmShiftHours([hourKpi('2026-10-15T04:00:00.000Z')], shift, undefined))).toEqual([
      '04:00',
    ]);
    // A shift that starts off the hour: the hours are the MES's, aligned on the hour.
    const half = { from: at('2026-10-15T03:30:00.000Z'), to: at('2026-10-15T05:30:00.000Z') };
    expect(keys(alarmShiftHours([], half, at('2026-10-15T09:00:00.000Z')))).toEqual([
      '03:00 quiet',
      '04:00 quiet',
      '05:00 quiet',
    ]);
  });
});
