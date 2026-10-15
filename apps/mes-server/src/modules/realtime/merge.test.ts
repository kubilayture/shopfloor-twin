import { describe, expect, it } from 'vitest';
import type { StoredInterval } from '../equipment/index.ts';
import { mergePieces } from './realtime.ts';

const t = (time: string): Date => new Date(`2026-10-12T${time}:00.000Z`);

/** One stored piece of the interval that started at `opened` (by `seq`) in `epoch`. */
const piece = (
  epoch: number,
  seq: number,
  opened: string,
  start: string,
  end: string,
  state = 'Running',
  provisional = false,
): StoredInterval => ({
  equipment: 'cnc-01',
  epoch,
  start: t(start),
  end: t(end),
  state,
  cause: null,
  hour: t(`${start.slice(0, 2)}:00`),
  shiftKey: '2026-10-12/A',
  provisional,
  intervalStart: t(opened),
  startSeq: seq,
});

const rows = (result: ReturnType<typeof mergePieces>) =>
  result.intervals.map((i) => [i.epoch, i.start.slice(11, 16), i.end.slice(11, 16), i.state]);

describe('merging stored pieces into intervals (#97)', () => {
  it('clips an interval of several pieces at `from` and keeps its true start', () => {
    const result = mergePieces(
      [
        piece(1, 1, '02:30', '02:30', '03:00'),
        piece(1, 1, '02:30', '03:00', '04:00'),
        piece(1, 1, '02:30', '04:00', '04:10'),
        piece(1, 2, '04:10', '04:10', '05:00', 'Stopped', true),
      ],
      t('03:20'),
      t('04:30'),
    );
    expect(rows(result)).toEqual([
      [1, '03:20', '04:10', 'Running'],
      [1, '04:10', '04:30', 'Stopped'],
    ]);
    expect(result.intervals[0]?.intervalStart).toBe(t('02:30').toISOString());
    expect(result.intervals.map((i) => i.provisional)).toEqual([false, true]);
    expect(result.next).toBeNull();
  });

  it('never merges across an epoch boundary, even at the same time and seq', () => {
    const result = mergePieces(
      [
        piece(1, 1, '03:00', '03:00', '04:00'),
        piece(2, 1, '03:00', '03:00', '03:30', 'Idle'),
        piece(1, 1, '03:00', '04:00', '04:15'),
        piece(2, 1, '03:00', '03:30', '04:00', 'Idle'),
      ],
      t('03:00'),
      t('05:00'),
    );
    expect(rows(result)).toEqual([
      [1, '03:00', '04:15', 'Running'],
      [2, '03:00', '04:00', 'Idle'],
    ]);
  });

  it('drops intervals that may continue beyond the row limit and says where to go on', () => {
    // The limit cut after the piece ending 05:00; the next stored piece starts at 05:00.
    const result = mergePieces(
      [
        piece(1, 1, '03:00', '03:00', '03:40'),
        piece(1, 2, '03:40', '03:40', '04:00', 'Stopped'),
        piece(1, 2, '03:40', '04:00', '04:20', 'Stopped'),
        piece(1, 3, '04:20', '04:20', '05:00'),
      ],
      t('03:00'),
      t('09:00'),
      t('05:00'),
    );
    expect(rows(result)).toEqual([
      [1, '03:00', '03:40', 'Running'],
      [1, '03:40', '04:20', 'Stopped'],
    ]);
    expect(result.next).toEqual(t('04:20'));
  });
});
