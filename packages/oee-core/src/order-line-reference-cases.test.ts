/**
 * Drives the Phase 9 tests from `docs/oee-reference-cases.md` (#229, ADR-0036): the derived
 * bottleneck, head times and job windows, order OEE, first-pass yield and line OEE, each checked
 * exactly against the hand-calculated tables.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveBottlenecks } from './bottleneck.ts';
import { formatFraction, fraction, toDecimal, type Fraction } from './fraction.ts';
import { intervalsFromFacts, type StateFact } from './intervals.ts';
import { lineOee, linePlannedBusyMs } from './line-oee.ts';
import {
  CYCLE_RESULTS,
  OEE_STATES,
  type CycleResult,
  type OeeConfig,
  type OeeState,
} from './oee.ts';
import {
  firstPassYield,
  jobWindows,
  orderOee,
  type HeadTime,
  type OrderJobInput,
  type QueuedJob,
  type TimedCycleCount,
  type TimelineInterval,
} from './order-oee.ts';
import type { Range } from './ranges.ts';

const DOC = readFileSync(
  resolve(import.meta.dirname, '../../../docs/oee-reference-cases.md'),
  'utf8',
);
const NULL = '–';

function table(heading: string): Record<string, string>[] {
  const section = DOC.split(/^## /m).find((part) => part.startsWith(`${heading}\n`));
  if (section === undefined) throw new Error(`no section "${heading}"`);
  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim()),
    );
  const [titles = [], , ...body] = rows;
  return body.map((cells) => Object.fromEntries(titles.map((t, i) => [t, cells[i] ?? ''])));
}

function cell(row: Record<string, string>, column: string): string {
  const value = row[column];
  if (value === undefined) throw new Error(`no column "${column}"`);
  return value;
}

function int(text: string): number {
  if (!/^-?\d{1,3}( \d{3})*$/.test(text)) throw new Error(`not a grouped integer: "${text}"`);
  return Number(text.replaceAll(' ', ''));
}

const grouped = (value: bigint | number): string =>
  value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const list = (text: string, separator = ';'): string[] =>
  text === NULL ? [] : text.split(separator).map((item) => item.trim());

/** "06:25" or "07:00:30" → ms from midnight. */
function time(text: string): number {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (match === null) throw new Error(`not a time: "${text}"`);
  const [, h = '0', m = '0', s = '0'] = match;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000;
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

const optionalTime = (text: string): number | undefined => (text === NULL ? undefined : time(text));

function range(text: string): Range {
  const [from = '', to = ''] = text.split('–');
  return { from: time(from), to: time(to) };
}

const ranges = (text: string): Range[] => list(text).map(range);

const clock = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
};

const shown = (value: Fraction | null): string => (value === null ? NULL : formatFraction(value));
const rounded = (value: Fraction | null): string => (value === null ? NULL : toDecimal(value));

const CONFIG: OeeConfig = {
  microStopThresholdMs: int(
    /\*\*Micro-stop threshold:\*\* ([\d ]+) ms/.exec(DOC)?.[1]?.trim() ?? '',
  ),
  scheduledTime: 'orders',
};

describe('bottleneck reference cases (B1–B4)', () => {
  const rows = table('Bottleneck, Phase 9');

  it('covers parallel machines, a tie and a fractional effective cycle', () => {
    expect(rows.map((row) => cell(row, 'Case'))).toEqual(['B1', 'B2', 'B3', 'B4']);
  });

  describe.each(rows.map((row) => [cell(row, 'Case'), row] as const))('case %s', (_, row) => {
    it('derives the expected bottleneck', () => {
      const equipment = list(cell(row, 'Equipment per operation')).flatMap((item) => {
        const [, operation = '', ids = ''] = /^(\S+) (.+)$/.exec(item) ?? [];
        return ids.split(',').map((id) => ({ id: id.trim(), operation }));
      });
      const operations = [...new Set(equipment.map((item) => item.operation))];
      const product = cell(row, 'Product');
      const ideal = Object.fromEntries(
        list(cell(row, 'Ideal cycle (ms)')).map((item) => {
          const [, op = '', ms = ''] = /^(\S+) (.+)$/.exec(item) ?? [];
          return [op, int(ms)];
        }),
      );
      const bottleneck = deriveBottlenecks({
        operations,
        equipment,
        idealCycleMs: { [product]: ideal },
      })[product];
      expect({
        Bottleneck: bottleneck?.operation,
        Machines: bottleneck?.equipment.join(', '),
        'Effective cycle (ms)': bottleneck && formatFraction(bottleneck.effectiveCycleMs),
      }).toEqual({
        Bottleneck: cell(row, 'Bottleneck'),
        Machines: cell(row, 'Machines'),
        'Effective cycle (ms)': cell(row, 'Effective cycle (ms)'),
      });
    });
  });
});

function queuedJob(row: Record<string, string>): QueuedJob {
  const completed = cell(row, 'Completed');
  const acceptedText = cell(row, 'Accepted');
  const accepted = acceptedText === 'lost' ? undefined : optionalTime(acceptedText);
  const quantity = row.Quantity ?? NULL;
  const ends = row['OP10 cycle ends'] ?? NULL;
  const acceptedAt = optionalTime(cell(row, 'Accepted at'));
  const started = optionalTime(cell(row, 'Started'));
  const notBefore = optionalTime(cell(row, 'Not before'));
  return {
    id: cell(row, 'Job'),
    ...(accepted === undefined ? {} : { accepted }),
    ...(acceptedText === 'lost' ? { acceptedLost: true } : {}),
    ...(quantity === NULL ? {} : { quantity: int(quantity) }),
    ...(ends === NULL ? {} : { cycleEnds: list(ends, ',').map(time) }),
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(started === undefined ? {} : { started }),
    ...(completed === 'lost'
      ? { completedLost: true }
      : completed === NULL
        ? {}
        : { completed: time(completed) }),
  };
}

const headText = (head: HeadTime): string =>
  head.kind === 'head'
    ? `${clock(head.at)} ${head.source}`
    : head.kind === 'waiting'
      ? 'waiting'
      : `unknown ${head.reason}`;

describe('head-time reference cases (H1–H21)', () => {
  const rows = table('Head times, Phase 9');
  const cases = [...new Set(rows.map((row) => cell(row, 'Case')))];

  it('has the twenty-one cases', () => {
    expect(cases).toEqual(Array.from({ length: 21 }, (_, i) => `H${String(i + 1)}`));
  });

  describe.each(cases)('case %s', (id) => {
    it('gives the expected head times and windows', () => {
      const queue = rows.filter((row) => cell(row, 'Case') === id);
      const jobs = queue.map(queuedJob);
      const until = time(cell(must(queue[0]), 'Until'));
      expect(queue.every((row) => time(cell(row, 'Until')) === until)).toBe(true);
      const paired = jobWindows(jobs, until, cell(must(queue[0]), 'Machine'));
      const actual = paired.map(({ head, window }) => {
        const windowText =
          window === undefined
            ? NULL
            : [
                `${clock(window.from)}–${clock(window.to)}`,
                window.open ? 'open' : '',
                window.headTimeUnknown ? 'headTimeUnknown' : '',
                window.endLost ? 'endLost' : '',
                window.lost ? 'lost' : '',
              ]
                .filter((part) => part !== '')
                .join(' ');
        return { head: headText(head), window: windowText };
      });
      expect(actual).toEqual(
        queue.map((row) => ({ head: cell(row, 'Head time'), window: cell(row, 'Window') })),
      );
    });
  });
});

const IDEAL_OP10 = { 'VB-100': { OP10: 240_000 }, 'VB-200': { OP10: 330_000 } };

function timeline(text: string, until: number): TimelineInterval[] {
  const facts: StateFact<OeeState>[] = list(text).map((item) => {
    const [, at = '', state = '', cause] = /^(\S+) (\S+)(?: (\S+))?$/.exec(item) ?? [];
    if (!OEE_STATES.includes(state as OeeState)) throw new Error(`unknown state in "${item}"`);
    return { at: time(at), state: state as OeeState, cause: cause ?? null };
  });
  const intervals = intervalsFromFacts(facts, until);
  return intervals.map((interval, i) => ({ ...interval, open: i === intervals.length - 1 }));
}

function cycles(text: string): TimedCycleCount[] {
  return list(text).map((item) => {
    const [, product = '', result = '', count = '', at = ''] =
      /^(\S+) (\S+) (\d+) @(\S+)$/.exec(item) ?? [];
    if (!CYCLE_RESULTS.includes(result as CycleResult)) throw new Error(`bad cycle "${item}"`);
    return { product, result: result as CycleResult, count: int(count), at: time(at) };
  });
}

describe('order OEE reference cases (O1–O11)', () => {
  const rows = table('Inputs, Phase 9 order OEE');
  const totalsRows = new Map(
    table('Expected totals, Phase 9 order OEE').map((row) => [cell(row, 'Case'), row]),
  );
  const resultRows = new Map(
    table('Expected results, Phase 9 order OEE').map((row) => [cell(row, 'Case'), row]),
  );
  const cases = [...new Set(rows.map((row) => cell(row, 'Case')))];

  it('has eleven cases, each with totals and results', () => {
    expect(cases).toEqual(['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9', 'O10', 'O11']);
    expect([...totalsRows.keys()]).toEqual(cases);
    expect([...resultRows.keys()]).toEqual(cases);
  });

  describe.each(cases)('case %s', (id) => {
    const jobRows = rows.filter((row) => cell(row, 'Case') === id);
    const scheduled = ranges(cell(jobRows[0] ?? {}, 'Scheduled'));
    const jobs: OrderJobInput[] = jobRows.map((row) => {
      const until = time(cell(row, 'Until'));
      const previous = cell(row, 'Previous completed');
      const job = queuedJob(row);
      const nextStarted = cell(row, 'Next started');
      // The CNC's queue: the job before this one (another order's), this job, the job after it.
      const queue: QueuedJob[] = [
        ...(previous === NULL
          ? []
          : [
              previous === 'lost'
                ? { id: 'previous', accepted: 0, completedLost: true }
                : { id: 'previous', accepted: 0, completed: time(previous) },
            ]),
        job,
        ...(nextStarted === NULL ? [] : [{ id: 'next', accepted: 0, started: time(nextStarted) }]),
      ];
      return {
        id: job.id,
        window: must(
          jobWindows(queue, until, cell(row, 'Machine')).find((paired) => paired.job === job),
        ).window,
        intervals: timeline(cell(row, 'States'), until),
        cycles: cycles(cell(row, 'Cycles')),
        operation: 'OP10',
      };
    });
    const result = orderOee({ jobs, scheduled, idealCycleMs: IDEAL_OP10 }, CONFIG);
    const { order } = result;

    it('matches the expected totals', () => {
      const losses = order.losses;
      const loss = (value: (l: NonNullable<typeof losses>) => bigint): string =>
        losses === null ? NULL : grouped(value(losses));
      const expected = totalsRows.get(id) ?? {};
      expect({
        PBT: grouped(order.totals.plannedBusyMs),
        APT: grouped(order.totals.actualProductionMs),
        'Own availability loss': loss((l) => l.availability.own.total),
        'External availability loss': loss((l) => l.availability.external.total),
        'Micro-stops': loss((l) => l.performance.microStops),
        'Speed loss': loss((l) => l.performance.speed),
        'Ideal time': grouped(order.totals.idealMs),
        Good: grouped(order.totals.good),
        Produced: grouped(order.totals.produced),
      }).toEqual(Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'Case')));
    });

    it('matches the expected fractions, four-decimal values and flags', () => {
      const flags = [
        order.anomaly && 'anomaly',
        order.provisional && 'provisional',
        result.headTimeUnknown && 'headTimeUnknown',
        result.open && 'open',
        result.pending && 'pending',
        result.endLost && 'endLost',
        result.lost && 'lost',
      ].filter((flag) => flag !== false);
      const expected = resultRows.get(id) ?? {};
      expect({
        A: shown(order.availability),
        P: shown(order.performance),
        Q: shown(order.quality),
        OEE: shown(order.oee),
        'A (4 dp)': rounded(order.availability),
        'P (4 dp)': rounded(order.performance),
        'Q (4 dp)': rounded(order.quality),
        'OEE (4 dp)': rounded(order.oee),
        Flags: flags.length > 0 ? flags.join(', ') : NULL,
      }).toEqual(Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'Case')));
    });
  });
});

describe('first-pass yield reference case (F1)', () => {
  it.each(table('First-pass yield, Phase 9').map((row) => [cell(row, 'Case'), row] as const))(
    'case %s',
    (_, row) => {
      const units = list(cell(row, 'Units')).flatMap((item) => {
        const [, n = '', records = ''] = /^(\d+) × (.+)$/.exec(item) ?? [];
        const route = {
          records: list(records, ',').map((record) => {
            const [operation = '', result = ''] = record.split(' ');
            return { operation, result: result as CycleResult };
          }),
        };
        return Array.from({ length: Number(n) }, () => route);
      });
      const fpy = firstPassYield({
        started: int(cell(row, 'Started')),
        units,
        lastOperation: 'OP50',
      });
      expect({
        'First-pass good': grouped(fpy.firstPassGood),
        FPY: shown(fpy.yield),
        'FPY (4 dp)': rounded(fpy.yield),
      }).toEqual({
        'First-pass good': cell(row, 'First-pass good'),
        FPY: cell(row, 'FPY'),
        'FPY (4 dp)': cell(row, 'FPY (4 dp)'),
      });
    },
  );
});

describe('line OEE reference cases (L1–L13)', () => {
  const rows = table('Line OEE, Phase 9');
  const expectedRows = new Map(
    table('Expected line OEE, Phase 9').map((row) => [cell(row, 'Case'), row]),
  );

  it('has thirteen cases, each with an expected row', () => {
    expect(rows.map((row) => cell(row, 'Case'))).toEqual([...expectedRows.keys()]);
    expect(rows).toHaveLength(13);
  });

  describe.each(rows.map((row) => [cell(row, 'Case'), row] as const))('case %s', (id, row) => {
    it('matches the expected planned busy time, ideal time, value and flags', () => {
      const progress = cell(row, 'Orders in progress');
      const inProgress =
        progress === NULL
          ? undefined
          : progress === 'none'
            ? []
            : list(progress).map((item) => range(item.split(' ')[1] ?? ''));
      const plannedBusyMs = linePlannedBusyMs({
        bucket: range(cell(row, 'Bucket')),
        scheduled: ranges(cell(row, 'Scheduled')),
        plannedStops: ranges(cell(row, 'Planned stops')),
        ...(inProgress === undefined ? {} : { inProgress }),
      });
      const good = list(cell(row, 'Good packed')).map((item) => {
        const [product = '', count = ''] = item.split(' ');
        return { product, count: int(count) };
      });
      const effectiveCycleMs = Object.fromEntries(
        list(cell(row, 'Bottleneck cycle (ms)')).map((item) => {
          const [, product = '', ms = ''] = /^(\S+) (.+)$/.exec(item) ?? [];
          return [product, fraction(BigInt(int(ms)))];
        }),
      );
      const result = lineOee({ plannedBusyMs, good, effectiveCycleMs });
      const ideal = result.idealMs;
      expect(ideal.den).toBe(1n);
      const expected = expectedRows.get(id) ?? {};
      expect({
        'Line PBT': grouped(result.plannedBusyMs),
        'Ideal time': grouped(ideal.num),
        Good: grouped(result.good),
        'Line OEE': shown(result.oee),
        'Line OEE (4 dp)': rounded(result.oee),
        Flags: result.aboveOne ? 'aboveOne' : NULL,
      }).toEqual(Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'Case')));
    });
  });
});
