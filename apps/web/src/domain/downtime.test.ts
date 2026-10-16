import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { REASONS, record } from '../test/oee-fixtures.ts';
import {
  codingBody,
  codingFailure,
  initialSegments,
  joinSegment,
  mergeRecords,
  plantTimeInRecord,
  reasonOptions,
  splitSegments,
  validateDraft,
  type DraftSegment,
} from './downtime.ts';

const T = (iso: string) => Date.parse(iso);
const START = T('2026-10-15T04:00:00.000Z');
const END = T('2026-10-15T04:10:00.000Z');
const options = reasonOptions(REASONS);

describe('reason tree', () => {
  it('keeps the tree order with depth and marks what can be coded', () => {
    expect(options.map((option) => [option.id, option.depth, option.codable])).toEqual([
      ['BREAKDOWN', 0, true],
      ['BREAKDOWN/SPINDLE-OVERLOAD', 1, true],
      ['BREAKDOWN/UNSPECIFIED', 1, true],
      ['SETUP', 0, true],
      ['SETUP/TOOL-CHANGE', 1, true],
      ['OLD', 0, false],
      ['UNCODED', 0, false],
    ]);
  });
});

describe('segments', () => {
  it('start as one automatic segment, or as the codings with the gaps between', () => {
    expect(initialSegments(record())).toEqual([{ from: START, to: END, reason: '', comment: '' }]);
    const coded = record({
      codings: [
        {
          from: '2026-10-15T04:02:00.000Z',
          to: '2026-10-15T04:05:00.000Z',
          reason: 'BREAKDOWN/SPINDLE-OVERLOAD',
          comment: 'bearing',
          codedBy: 'Ayşe',
          codedAt: '2026-10-16T08:00:00.000Z',
          version: 3,
        },
      ],
    });
    expect(initialSegments(coded)).toEqual([
      { from: START, to: T('2026-10-15T04:02:00.000Z'), reason: '', comment: '' },
      {
        from: T('2026-10-15T04:02:00.000Z'),
        to: T('2026-10-15T04:05:00.000Z'),
        reason: 'BREAKDOWN/SPINDLE-OVERLOAD',
        comment: 'bearing',
      },
      { from: T('2026-10-15T04:05:00.000Z'), to: END, reason: '', comment: '' },
    ]);
    // An open record runs to its length so far.
    expect(initialSegments(record({ end: null }))[0]?.to).toBe(START + 300_000);
  });

  it('split at a time and join back', () => {
    const one: DraftSegment[] = [{ from: START, to: END, reason: 'SETUP', comment: 'x' }];
    const at = T('2026-10-15T04:04:00.000Z');
    const two = splitSegments(one, at);
    expect(two).toEqual([
      { from: START, to: at, reason: 'SETUP', comment: 'x' },
      { from: at, to: END, reason: 'SETUP', comment: 'x' },
    ]);
    expect(splitSegments(two, at)).toEqual(two);
    expect(joinSegment(two, 1)).toEqual(one);
    expect(joinSegment(two, 0)).toEqual(two);
  });

  it('reads a plant time inside the record, also across midnight', () => {
    // 04:04 UTC is 07:04 in Istanbul (+03:00).
    expect(plantTimeInRecord('07:04', record())).toBe(T('2026-10-15T04:04:00.000Z'));
    expect(plantTimeInRecord('07:04:30', record())).toBe(T('2026-10-15T04:04:30.000Z'));
    expect(plantTimeInRecord('07:00', record())).toBeUndefined();
    expect(plantTimeInRecord('08:00', record())).toBeUndefined();
    expect(plantTimeInRecord('25:00', record())).toBeUndefined();
    expect(plantTimeInRecord('noon', record())).toBeUndefined();
    const night = record({ start: '2026-10-15T20:50:00.000Z', end: '2026-10-15T21:20:00.000Z' });
    // 23:50 to 00:20 plant time: 00:10 is on the next plant day.
    expect(plantTimeInRecord('00:10', night)).toBe(T('2026-10-15T21:10:00.000Z'));
  });
});

describe('the coding form', () => {
  const draft = (segments: DraftSegment[]) => ({ segments });

  it('accepts a valid split and refuses what the MES would refuse', () => {
    const at = T('2026-10-15T04:04:00.000Z');
    const valid = draft([
      { from: START, to: at, reason: 'BREAKDOWN/SPINDLE-OVERLOAD', comment: '' },
      { from: at, to: END, reason: '', comment: '' },
    ]);
    expect(validateDraft(valid, record(), options)).toEqual([]);
    expect(
      validateDraft(
        draft([
          { from: START - 1, to: at, reason: 'UNCODED', comment: 'y'.repeat(501) },
          { from: at - 1, to: at - 1, reason: 'OLD', comment: '' },
        ]),
        record(),
        options,
      ),
    ).toEqual([
      'Segment 1 lies outside the record.',
      'Segment 1: choose an active reason (not "Not coded").',
      'Segment 1: the comment may have at most 500 characters.',
      'Segment 2 is empty.',
      'Segment 2 overlaps the one before.',
      'Segment 2: choose an active reason (not "Not coded").',
    ]);
    // The limit counts the comment as sent: trimmed.
    const padded = { from: START, to: END, reason: 'SETUP', comment: ` ${'y'.repeat(500)} ` };
    expect(validateDraft(draft([padded]), record(), options)).toEqual([]);
    const many = Array.from({ length: 33 }, (_unused, index) => ({
      from: START + index,
      to: START + index + 1,
      reason: 'SETUP',
      comment: '',
    }));
    expect(validateDraft(draft(many), record(), options)).toEqual(['At most 32 coded segments.']);
  });

  it('sends only coded segments, trimmed, with the version read and no coder', () => {
    const at = T('2026-10-15T04:04:00.000Z');
    expect(
      codingBody(
        draft([
          { from: START, to: at, reason: 'BREAKDOWN/SPINDLE-OVERLOAD', comment: ' bearing ' },
          { from: at, to: END, reason: '', comment: 'ignored' },
        ]),
        7,
      ),
    ).toEqual({
      segments: [
        {
          from: '2026-10-15T04:00:00.000Z',
          to: '2026-10-15T04:04:00.000Z',
          reason: 'BREAKDOWN/SPINDLE-OVERLOAD',
          comment: 'bearing',
        },
      ],
      version: 7,
    });
    expect(codingBody(draft([]), 0)).toEqual({ segments: [], version: 0 });
  });

  it('explains every refusal of the MES', () => {
    const problem = (status: number, detail: string) =>
      new ApiError(`x: ${detail}`, status, {
        type: 'about:blank',
        title: 'x',
        status,
        detail,
        instance: '/api/v1/downtime/x/coding',
      });
    expect(codingFailure(problem(409, 'version 3 is not 4')).kind).toBe('conflict');
    expect(codingFailure(problem(403, 'Origin not allowed')).text).toContain('Origin not allowed');
    expect(codingFailure(problem(405, 'off')).kind).toBe('refused');
    expect(codingFailure(problem(415, 'Content-Type')).text).toContain('only JSON');
    expect(codingFailure(problem(422, 'segment outside the record')).text).toContain(
      'segment outside the record',
    );
    expect(codingFailure(new ApiError('slow', 429, undefined, 3)).text).toContain('in 3 s');
    expect(codingFailure(problem(400, 'bad')).kind).toBe('invalid');
    expect(codingFailure(new ApiError('down', 0)).kind).toBe('unavailable');
    expect(codingFailure(problem(503, 'starting')).text).toContain('503');
    expect(codingFailure(new Error('boom')).text).toBe('boom');
  });
});

describe('records with pushes', () => {
  const range = { from: T('2026-10-15T03:00:00.000Z'), to: T('2026-10-15T11:00:00.000Z') };

  it('upserts by id, adds new ones in range, drops removed ones and sorts uncoded first', () => {
    const a = record();
    const b = record({
      id: 'wsh-01~1~2',
      equipment: 'wsh-01',
      start: '2026-10-15T03:30:00.000Z',
      end: '2026-10-15T03:40:00.000Z',
      uncoded: false,
      reason: 'SETUP',
    });
    const recoded = { ...a, uncoded: false, reason: 'SETUP', version: 4 };
    const created = record({ id: 'cnc-01~1~9', start: '2026-10-15T05:00:00.000Z', end: null });
    const outside = record({ id: 'cnc-01~1~10', start: '2026-10-15T12:00:00.000Z' });
    const live = {
      seq: 4,
      records: {
        [a.id]: { record: recoded, removed: false },
        [created.id]: { record: created, removed: false },
        [outside.id]: { record: outside, removed: false },
        [b.id]: { record: b, removed: true },
      },
    };
    expect(mergeRecords([a, b], live, range).map((r) => [r.id, r.reason])).toEqual([
      [created.id, 'UNCODED'],
      [a.id, 'SETUP'],
    ]);
    // An older push never takes a record back.
    const stale = { seq: 1, records: { [a.id]: { record: { ...a, version: 2 }, removed: false } } };
    expect(mergeRecords([a], stale, range)[0]?.version).toBe(3);
    expect(mergeRecords([a], undefined, range)).toEqual([a]);
  });
});
