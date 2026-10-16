/**
 * Drives the tests from `docs/alarm-kpi-reference-cases.md` (Phase 6 plan, exit criterion 1): the
 * hand-calculated tables are parsed and every case is checked exactly, as counts, fractions and
 * four-decimal strings, with its flood episodes, bad actors and revised hours.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatFraction, toDecimal } from '@shopfloor/oee-core';
import { describe, expect, it } from 'vitest';
import { badActors } from './bad-actors.ts';
import { kpisOfBucket, type Bucket } from './buckets.ts';
import { floodEpisodes } from './floods.ts';
import {
  HOUR,
  PRIORITIES,
  prepare,
  type AlarmKpiConfig,
  type Horizon,
  type Occurrence,
  type Priority,
} from './occurrences.ts';
import { revisedHours, type LateFact } from './revisions.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const DOC = readFileSync(resolve(ROOT, 'docs/alarm-kpi-reference-cases.md'), 'utf8');
const NULL = '–';

/** The rows of the Markdown table under `## <heading>`, as cells keyed by column title. */
function table(heading: string): Record<string, string>[] {
  const section = DOC.split(/^## /m).find((part) => part.startsWith(`${heading}\n`));
  if (section === undefined) {
    throw new Error(`no section "${heading}" in the reference cases`);
  }
  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
  const [titles = [], , ...body] = rows;
  return body.map((cells) => Object.fromEntries(titles.map((title, i) => [title, cells[i] ?? ''])));
}

const cell = (row: Record<string, string>, column: string): string => {
  const value = row[column];
  if (value === undefined) {
    throw new Error(`no column "${column}"`);
  }
  return value;
};

/** "3 600 000" → 3600000. */
function int(text: string): number {
  if (!/^-?\d{1,3}( \d{3})*$/.test(text)) {
    throw new Error(`not a grouped integer: "${text}"`);
  }
  return Number(text.replaceAll(' ', ''));
}

const grouped = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONDAY = Date.UTC(2026, 9, 12);

/** "Mon 10:00:00.000" or "Mon 10:00" → ms. */
function time(text: string): number {
  const match = /^(\w{3}) (\d{2}):(\d{2})(?::(\d{2})\.(\d{3}))?$/.exec(text);
  const day = DAYS.indexOf(match?.[1] ?? '');
  if (match === null || day < 0) {
    throw new Error(`not a time: "${text}"`);
  }
  const [, , hh = '', mm = '', ss = '0', ms = '0'] = match;
  return (
    MONDAY +
    day * 24 * HOUR +
    Number(hh) * HOUR +
    Number(mm) * 60_000 +
    Number(ss) * 1000 +
    Number(ms)
  );
}

function showTime(at: number): string {
  const offset = at - MONDAY;
  const day = DAYS[Math.floor(offset / (24 * HOUR))] ?? '?';
  const iso = new Date(at).toISOString();
  return `${day} ${iso.slice(11, 23)}`;
}

const showHour = (at: number): string => showTime(at).slice(0, -7);

/** "Mon 10:00–11:00" or "Mon 22:00–Tue 06:00". */
function bucket(text: string): Bucket {
  const [from = '', to = ''] = text.split('–');
  const day = from.slice(0, 3);
  return { from: time(from), to: time(to.includes(' ') ? to : `${day} ${to}`) };
}

function showBucket({ from, to }: Bucket): string {
  const a = showHour(from);
  const z = showHour(to);
  return `${a}–${z.slice(0, 3) === a.slice(0, 3) ? z.slice(4) : z}`;
}

const DEFINITIONS =
  /\*\*floodThreshold ([\d ]+), windowMs ([\d ]+), chatterCount ([\d ]+), chatterWindowMs ([\d ]+), fleetingMs ([\d ]+), standingMs ([\d ]+)\.\*\*/.exec(
    DOC,
  );
const CONFIG: AlarmKpiConfig = {
  floodThreshold: int(DEFINITIONS?.[1] ?? ''),
  windowMs: int(DEFINITIONS?.[2] ?? ''),
  chatterCount: int(DEFINITIONS?.[3] ?? ''),
  chatterWindowMs: int(DEFINITIONS?.[4] ?? ''),
  fleetingMs: int(DEFINITIONS?.[5] ?? ''),
  standingMs: int(DEFINITIONS?.[6] ?? ''),
};

const occurrences = new Map<string, Occurrence[]>();
for (const row of table('Occurrences')) {
  const id = cell(row, 'Case');
  const [equipment = '', code = ''] = cell(row, 'Point').split('/');
  const priority = cell(row, 'Priority') as Priority;
  if (!PRIORITIES.includes(priority)) {
    throw new Error(`unknown priority in case ${id}`);
  }
  const repeat = cell(row, 'Repeat (n × step ms)');
  const [count, step] = repeat === NULL ? [1, 0] : repeat.split(' × ').map(int);
  const cleared = cell(row, 'Cleared (after raise, ms)');
  const list = occurrences.get(id) ?? [];
  for (let k = 0; k < (count ?? 1); k += 1) {
    const raisedAt = time(cell(row, 'Raised')) + k * (step ?? 0);
    list.push({
      equipment,
      code,
      priority,
      seq: int(cell(row, 'Seq')) + k,
      raisedAt,
      clearedAt: cleared === NULL ? null : raisedAt + int(cleared.slice(1)),
    });
  }
  occurrences.set(id, list);
}

const horizons = new Map<string, Horizon>(
  table('Horizons').map((row) => [
    cell(row, 'Case'),
    {
      asOf: time(cell(row, 'As of')),
      closedAt: cell(row, 'Closed') === NULL ? null : time(cell(row, 'Closed')),
    },
  ]),
);

const setOf = (id: string) => {
  const horizon = horizons.get(id);
  if (horizon === undefined) {
    throw new Error(`no horizon for case ${id}`);
  }
  return prepare(occurrences.get(id) ?? [], horizon, CONFIG);
};

const byCase = (rows: Record<string, string>[]): Map<string, Record<string, string>[]> => {
  const map = new Map<string, Record<string, string>[]>();
  for (const row of rows) {
    map.set(cell(row, 'Case'), [...(map.get(cell(row, 'Case')) ?? []), row]);
  }
  return map;
};

const bucketRows = byCase(table('Expected buckets'));
const episodeRows = byCase(table('Expected flood episodes'));
const actorRows = byCase(table('Expected bad actors'));
const revisionRows = byCase(table('Expected revisions'));

function lateFact(text: string): LateFact {
  const end = /^end raised (.+?) from (.+?) to (.+)$/.exec(text);
  if (end !== null) {
    const [, raised = '', before = '', after = ''] = end;
    const at = (value: string): number | null => (value === NULL ? null : time(value));
    return { kind: 'end', raisedAt: time(raised), before: at(before), after: at(after) };
  }
  const raise = /^raise (\S+)\/(\S+) (\w{3} \S+) cleared (.+)$/.exec(text);
  if (raise === null) {
    throw new Error(`not a late fact: "${text}"`);
  }
  const [, equipment = '', code = '', raised = '', cleared = ''] = raise;
  const raisedAt = time(raised);
  return {
    kind: 'raise',
    equipment,
    code,
    raisedAt,
    clearedAt: cleared === NULL ? null : raisedAt + int(cleared.slice(1)),
  };
}

describe('alarm KPI reference cases (docs/alarm-kpi-reference-cases.md)', () => {
  it('uses the thresholds of config/plant/alarms.yaml', () => {
    const yaml = readFileSync(resolve(ROOT, 'config/plant/alarms.yaml'), 'utf8');
    for (const [name, value] of Object.entries(CONFIG)) {
      expect(new RegExp(`^  ${name}: ${String(value)}$`, 'm').test(yaml), name).toBe(true);
    }
  });

  it('has at least 14 cases, each with a horizon and expectations', () => {
    expect(occurrences.size).toBeGreaterThanOrEqual(14);
    expect([...horizons.keys()]).toEqual([...occurrences.keys()]);
    const expected = new Set([
      ...bucketRows.keys(),
      ...episodeRows.keys(),
      ...actorRows.keys(),
      ...revisionRows.keys(),
    ]);
    expect([...expected].sort()).toEqual([...occurrences.keys()].sort());
    expect(revisionRows.size).toBeGreaterThanOrEqual(3);
  });

  describe.each([...occurrences.keys()])('case %s', (id) => {
    const set = setOf(id);
    const episodes = floodEpisodes(set);

    it('matches the expected buckets', () => {
      for (const row of bucketRows.get(id) ?? []) {
        const kpis = kpisOfBucket(set, episodes, bucket(cell(row, 'Bucket')));
        const p = kpis.byPriority;
        const floods = kpis.floods.map((flood) => {
          const episode = episodes.find((e) => e.id === flood.id);
          const head = `${showTime(flood.startAt)} ${episode?.equipment ?? '?'}#${String(episode?.seq)}: ${grouped(flood.floodMs)} ms, peak ${String(flood.peak)}, `;
          return flood.ended === null
            ? `${head}open`
            : `${head}ended ${showTime(flood.ended.endAt)} (peak ${String(flood.ended.peak)}, raises ${String(flood.ended.raises)})`;
        });
        expect({
          Case: id,
          Bucket: showBucket(kpis),
          'Raises (H/M/L)': `${String(kpis.raises)} (${String(p.high)}/${String(p.medium)}/${String(p.low)})`,
          'Rate per 10 min': formatFraction(kpis.averageRate),
          'Rate (4 dp)': toDecimal(kpis.averageRate),
          'Peak 10': String(kpis.peak10),
          'Flood windows': `${String(kpis.floodWindows)} of ${String(kpis.windows)}`,
          'Floods (flood ms)': floods.length > 0 ? floods.join('; ') : NULL,
          'Active at end': String(kpis.activeAtEnd),
          Standing:
            kpis.standing.length > 0
              ? kpis.standing.map((s) => `${s.equipment}/${s.code}#${String(s.seq)}`).join('; ')
              : NULL,
          Chattering:
            kpis.chatteringRaises > 0
              ? `${String(kpis.chatteringRaises)} (${kpis.chatteringPoints.join(', ')})`
              : '0',
          Fleeting:
            kpis.fleetingUndecided > 0
              ? `${String(kpis.fleeting)} (${String(kpis.fleetingUndecided)} undecided)`
              : String(kpis.fleeting),
          'Active ms': grouped(kpis.activeMs),
          Flags: kpis.provisional ? 'provisional' : NULL,
        }).toEqual(row);
      }
    });

    it('matches the expected flood episodes', () => {
      expect(
        episodes.map((episode) => ({
          Case: id,
          Start: showTime(episode.startAt),
          'Starting raise': `${episode.equipment}#${String(episode.seq)}`,
          End: episode.endAt === null ? `${NULL} (open)` : showTime(episode.endAt),
          Peak: String(episode.peak),
          Raises: String(episode.raises),
        })),
      ).toEqual(episodeRows.get(id) ?? []);
    });

    it('matches the expected bad actors', () => {
      const rows = actorRows.get(id) ?? [];
      const range = rows[0] === undefined ? null : cell(rows[0], 'Range');
      const actual =
        range === null
          ? []
          : badActors(set, bucket(range)).map((actor, i) => ({
              Case: id,
              Range: range,
              Rank: String(i + 1),
              Point: `${actor.equipment}/${actor.code}`,
              Raises: String(actor.raises),
              Share: formatFraction(actor.share),
              'Share (4 dp)': toDecimal(actor.share),
              'Active ms': grouped(actor.activeMs),
              Chattering: String(actor.chatteringRaises),
            }));
      expect(actual).toEqual(rows);
    });

    it('matches the expected revised hours', () => {
      for (const row of revisionRows.get(id) ?? []) {
        const hours = revisedHours(lateFact(cell(row, 'Late fact')), set);
        expect(hours.map(showHour).join('; ')).toBe(cell(row, 'Revised hours'));
      }
    });
  });
});
