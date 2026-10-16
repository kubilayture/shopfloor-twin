/**
 * Drives the tests from `docs/oee-reference-cases.md` (plan section 9): the hand-calculated
 * tables are parsed and every case is checked exactly, as fractions and as four-decimal strings.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatFraction, toDecimal, type Fraction } from './fraction.ts';
import {
  CYCLE_RESULTS,
  OEE_STATES,
  workCenterOee,
  type BucketInput,
  type CycleResult,
  type OeeConfig,
  type OeeState,
} from './oee.ts';

const DOC = readFileSync(
  resolve(import.meta.dirname, '../../../docs/oee-reference-cases.md'),
  'utf8',
);

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

/** "3 600 000" → 3600000; "-30 000" → -30000. */
function int(text: string): number {
  if (!/^-?\d{1,3}( \d{3})*$/.test(text)) {
    throw new Error(`not a grouped integer: "${text}"`);
  }
  return Number(text.replaceAll(' ', ''));
}

const list = (text: string): string[] =>
  text === NULL ? [] : text.split(';').map((item) => item.trim());

function parseInput(row: Record<string, string>): BucketInput {
  const operation = cell(row, 'Operation');
  const stateMs: Partial<Record<OeeState, number>> = {};
  let noOrderIdleMs: number | undefined;
  for (const item of list(cell(row, 'States (ms)'))) {
    const noOrder = /^Idle NO-ORDER (.+)$/.exec(item)?.[1];
    if (noOrder !== undefined) {
      // Idle with cause NO-ORDER (#172): Idle time, and the part `orders` excludes.
      noOrderIdleMs = (noOrderIdleMs ?? 0) + int(noOrder);
      stateMs.Idle = (stateMs.Idle ?? 0) + int(noOrder);
      continue;
    }
    const [, state = '', ms = ''] = /^([A-Za-z]+) (.+)$/.exec(item) ?? [];
    if (!OEE_STATES.includes(state as OeeState)) {
      throw new Error(`unknown state in "${item}"`);
    }
    stateMs[state as OeeState] = int(ms);
  }
  const stops = list(cell(row, 'Stopped pieces (piece / whole ms)')).map((item) => {
    const [, ms = '', whole = '', open] = /^(.+?) \/ (.+?)( open)?$/.exec(item) ?? [];
    return { ms: int(ms), wholeMs: int(whole), open: open !== undefined };
  });
  const cycles = list(cell(row, 'Cycles')).map((item) => {
    const [, product = '', result = '', count = ''] = /^(\S+) (\S+) (.+)$/.exec(item) ?? [];
    if (!CYCLE_RESULTS.includes(result as CycleResult)) {
      throw new Error(`unknown result in "${item}"`);
    }
    return { product, result: result as CycleResult, count: int(count) };
  });
  const idealCycleMs = Object.fromEntries(
    list(cell(row, 'Ideal cycle (ms)')).map((item) => {
      const [, product = '', ms = ''] = /^(\S+) (.+)$/.exec(item) ?? [];
      return [product, { [operation]: int(ms) }];
    }),
  );
  const scheduled = cell(row, 'Scheduled');
  if (scheduled !== 'yes' && scheduled !== 'no') {
    throw new Error(`Scheduled must be yes or no, got "${scheduled}"`);
  }
  return {
    scheduled: scheduled === 'yes',
    stateMs,
    ...(noOrderIdleMs === undefined ? {} : { noOrderIdleMs }),
    stops,
    cycles,
    operation,
    idealCycleMs,
  };
}

const thresholdText = /\*\*Micro-stop threshold:\*\* ([\d ]+) ms/.exec(DOC)?.[1] ?? '';
const CONFIG: OeeConfig = {
  microStopThresholdMs: int(thresholdText.trim()),
  scheduledTime: 'shift-calendar',
};

interface CaseSet {
  readonly inputs: Map<string, BucketInput[]>;
  /** The scheduled-time rule per case. */
  readonly rules: Map<string, OeeConfig['scheduledTime']>;
  readonly totals: Map<string, Record<string, string>>;
  readonly results: Map<string, Record<string, string>>;
}

/** The cases under `## Inputs<suffix>` and its two expected tables. */
function caseSet(suffix: string): CaseSet {
  const inputs = new Map<string, BucketInput[]>();
  const rules = new Map<string, OeeConfig['scheduledTime']>();
  for (const row of table(`Inputs${suffix}`)) {
    const id = cell(row, 'Case');
    inputs.set(id, [...(inputs.get(id) ?? []), parseInput(row)]);
    const rule = row.Rule ?? 'shift-calendar';
    if (rule !== 'shift-calendar' && rule !== 'orders') {
      throw new Error(`unknown rule "${rule}"`);
    }
    if (rules.has(id) && rules.get(id) !== rule) {
      throw new Error(`case ${id} has rows with different rules`);
    }
    rules.set(id, rule);
  }
  return {
    inputs,
    rules,
    totals: new Map(table(`Expected totals${suffix}`).map((row) => [cell(row, 'Case'), row])),
    results: new Map(table(`Expected results${suffix}`).map((row) => [cell(row, 'Case'), row])),
  };
}

const PHASE_5 = caseSet('');
const PHASE_7 = caseSet(', Phase 7');
const inputs = PHASE_5.inputs;
const totalsRows = PHASE_5.totals;
const resultRows = PHASE_5.results;

const shown = (value: Fraction | null): string => (value === null ? NULL : formatFraction(value));
const rounded = (value: Fraction | null): string => (value === null ? NULL : toDecimal(value));
const grouped = (value: bigint): string => value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

describe('OEE reference cases (docs/oee-reference-cases.md)', () => {
  it('has at least 12 cases, each with inputs, totals and results', () => {
    expect(CONFIG.microStopThresholdMs).toBe(120_000);
    expect(inputs.size).toBeGreaterThanOrEqual(12);
    expect([...totalsRows.keys()]).toEqual([...inputs.keys()]);
    expect([...resultRows.keys()]).toEqual([...inputs.keys()]);
    expect(table('Expected results')).toHaveLength(inputs.size);
    expect(table('Expected totals')).toHaveLength(inputs.size);
  });

  it('includes the work-center aggregates (several equipment rows)', () => {
    expect([...inputs.values()].filter((rows) => rows.length > 1).length).toBeGreaterThanOrEqual(1);
  });

  describe.each([...inputs.keys()])('case %s', (id) => {
    checkCase(PHASE_5, id);
  });
});

describe('OEE reference cases of the orders rule (#172, docs/oee-reference-cases.md)', () => {
  it('covers NO-ORDER in a shift, across an hour, in no-shift, and the other Idle causes', () => {
    expect([...PHASE_7.inputs.keys()]).toEqual(['20', '21', '22', '23', '24', '25']);
    expect([...PHASE_7.totals.keys()]).toEqual([...PHASE_7.inputs.keys()]);
    expect([...PHASE_7.results.keys()]).toEqual([...PHASE_7.inputs.keys()]);
    expect(new Set(PHASE_7.rules.values())).toEqual(new Set(['orders', 'shift-calendar']));
    expect(PHASE_7.inputs.get('22')).toHaveLength(2);
  });

  describe.each([...PHASE_7.inputs.keys()])('case %s', (id) => {
    checkCase(PHASE_7, id);
  });
});

function checkCase(set: CaseSet, id: string): void {
  const config: OeeConfig = { ...CONFIG, scheduledTime: set.rules.get(id) ?? 'shift-calendar' };
  const result = workCenterOee(set.inputs.get(id) ?? [], config);
  const totals = set.totals.get(id) ?? {};
  const expected = set.results.get(id) ?? {};
  const { losses } = result;
  const loss = (value: (l: NonNullable<typeof losses>) => bigint): string =>
    losses === null ? NULL : grouped(value(losses));
  it('matches the expected totals', () => {
    expect({
      PBT: grouped(result.totals.plannedBusyMs),
      APT: grouped(result.totals.actualProductionMs),
      'Own availability loss': loss((l) => l.availability.own.total),
      'External availability loss': loss((l) => l.availability.external.total),
      'Micro-stops': loss((l) => l.performance.microStops),
      'Speed loss': loss((l) => l.performance.speed),
      'Ideal time': grouped(result.totals.idealMs),
      Good: grouped(result.totals.good),
      Produced: grouped(result.totals.produced),
      'Unplanned good': grouped(result.totals.unplanned.good),
      'Unplanned produced': grouped(result.totals.unplanned.produced),
      'Unplanned ideal time': grouped(result.totals.unplanned.idealMs),
    }).toEqual(Object.fromEntries(Object.entries(totals).filter(([key]) => key !== 'Case')));
  });

  it('matches the expected fractions, four-decimal values and flags', () => {
    const flags = [result.anomaly && 'anomaly', result.provisional && 'provisional'].filter(
      (flag) => flag !== false,
    );
    expect({
      A: shown(result.availability),
      P: shown(result.performance),
      Q: shown(result.quality),
      OEE: shown(result.oee),
      'A (4 dp)': rounded(result.availability),
      'P (4 dp)': rounded(result.performance),
      'Q (4 dp)': rounded(result.quality),
      'OEE (4 dp)': rounded(result.oee),
      Flags: flags.length > 0 ? flags.join(', ') : NULL,
    }).toEqual(Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'Case')));
  });
}
