import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { ACK, kpiBucket, occurrence, point, shelf } from '../test/alarm-fixtures.ts';
import {
  MAX_SHELVE_MS,
  SHELVE_PRESETS,
  acknowledgeable,
  alarmBucketFlags,
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
  rateBand,
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

  it('offers no shelving preset beyond maxShelveMs', () => {
    expect(SHELVE_PRESETS.map((preset) => preset.label)).toEqual(['15 min', '1 h', '4 h', '8 h']);
    expect(SHELVE_PRESETS.every((preset) => preset.ms <= MAX_SHELVE_MS)).toBe(true);
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
  it('compares the average rate with the benchmarks exactly', () => {
    expect(rateBand({ fraction: '1/1', decimal: '1.0000' })).toBe('acceptable');
    expect(rateBand({ fraction: '1000001/1000000', decimal: '1.0000' })).toBe('manageable');
    expect(rateBand({ fraction: '2/1', decimal: '2.0000' })).toBe('manageable');
    expect(rateBand({ fraction: '49/24', decimal: '2.0417' })).toBe('over');
    expect(rateBand({ fraction: '0/1', decimal: '0.0000' })).toBe('acceptable');
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
