import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatIssues, loadPlantConfig, validatePlantConfig } from './load.ts';
import {
  LOSS_STATES,
  UNCODED,
  classifyCause,
  matchesCause,
  parentReason,
  plantCauses,
  type ReasonRule,
} from './reasons.ts';
import { PLANT_FILES, type PlantConfig } from './schema.ts';

const DEFAULT_DIR = resolve(import.meta.dirname, '../../../config/plant');

type Raw = Record<keyof typeof PLANT_FILES, unknown>;

let defaults: Raw;
let config: PlantConfig;

beforeAll(async () => {
  const entries = await Promise.all(
    Object.keys(PLANT_FILES).map(async (file) => [
      file,
      parse(await readFile(join(DEFAULT_DIR, `${file}.yaml`), 'utf8')) as unknown,
    ]),
  );
  defaults = Object.fromEntries(entries) as Raw;
  const loaded = await loadPlantConfig(DEFAULT_DIR);
  if (!loaded.ok) throw new Error(formatIssues(loaded.issues));
  config = loaded.config;
});

const messagesFor = (change: (config: PlantConfig) => void): string => {
  const copy = structuredClone(defaults) as PlantConfig;
  change(copy);
  const result = validatePlantConfig(copy);
  return result.ok
    ? ''
    : result.issues.map((issue) => `${issue.file}:${issue.path}: ${issue.message}`).join('\n');
};

describe('rule matching (#119)', () => {
  const rules: ReasonRule[] = [
    { state: 'Down', cause: 'SPINDLE-OVERLOAD', reason: 'BREAKDOWN/SPINDLE-OVERLOAD' },
    { state: 'Down', cause: { any: true }, reason: 'BREAKDOWN/OTHER' },
    // Shadowed by the rule above: the first match wins.
    { state: 'Down', cause: null, reason: 'BREAKDOWN/UNSPECIFIED' },
    { state: 'Setup', cause: { prefix: 'CHANGEOVER ' }, reason: 'SETUP/CHANGEOVER' },
    { state: 'Starved', cause: null, reason: 'STARVED' },
  ];

  it('matches exact, prefix, null and any', () => {
    expect(matchesCause('X', 'X')).toBe(true);
    expect(matchesCause('X', 'XY')).toBe(false);
    expect(matchesCause('X', null)).toBe(false);
    expect(matchesCause({ prefix: 'MATERIAL:' }, 'MATERIAL:BLANK-100')).toBe(true);
    expect(matchesCause({ prefix: 'MATERIAL:' }, 'MATERIAL')).toBe(false);
    expect(matchesCause({ prefix: 'MATERIAL:' }, null)).toBe(false);
    expect(matchesCause(null, null)).toBe(true);
    expect(matchesCause(null, 'X')).toBe(false);
    expect(matchesCause({ any: true }, 'X')).toBe(true);
    expect(matchesCause({ any: true }, null)).toBe(true);
  });

  it('takes the first matching rule, else UNCODED', () => {
    expect(classifyCause(rules, 'Down', 'SPINDLE-OVERLOAD')).toBe('BREAKDOWN/SPINDLE-OVERLOAD');
    expect(classifyCause(rules, 'Down', 'COOLANT-PRESSURE')).toBe('BREAKDOWN/OTHER');
    expect(classifyCause(rules, 'Down', null)).toBe('BREAKDOWN/OTHER');
    expect(classifyCause(rules, 'Setup', 'CHANGEOVER none→VB-100')).toBe('SETUP/CHANGEOVER');
    expect(classifyCause(rules, 'Setup', 'TOOL-CHANGE')).toBe(UNCODED);
    expect(classifyCause(rules, 'Starved', null)).toBe('STARVED');
    expect(classifyCause(rules, 'Starved', 'MATERIAL:X')).toBe(UNCODED);
    // The state must match too.
    expect(classifyCause(rules, 'Stopped', 'SPINDLE-OVERLOAD')).toBe(UNCODED);
    expect(classifyCause([], 'Down', null)).toBe(UNCODED);
  });

  it('derives the parent from the id path', () => {
    expect(parentReason('BREAKDOWN/SPINDLE-OVERLOAD')).toBe('BREAKDOWN');
    expect(parentReason('A/B/C')).toBe('A/B');
    expect(parentReason('UNCODED')).toBeNull();
  });
});

describe('the default reason codes (#119)', () => {
  it('code every cause of the plant model and every loss state without a cause', () => {
    const pairs = [...plantCauses(config), ...LOSS_STATES.map((state) => ({ state, cause: null }))];
    expect(pairs.length).toBeGreaterThan(25);
    const uncoded = pairs.filter(
      (pair) => classifyCause(config.reasons.rules, pair.state, pair.cause) === UNCODED,
    );
    expect(uncoded).toEqual([]);
    expect(classifyCause(config.reasons.rules, 'Setup', 'CHANGEOVER VB-100→VB-200')).toBe(
      'SETUP/CHANGEOVER',
    );
    expect(classifyCause(config.reasons.rules, 'Starved', 'MATERIAL:BLANK-100')).toBe('MATERIAL');
    expect(classifyCause(config.reasons.rules, 'Blocked', null)).toBe('BLOCKED');
    expect(classifyCause(config.reasons.rules, 'Idle', 'SCHEDULE-COMPLETE')).toBe(
      'ORGANISATION/NO-SCHEDULE',
    );
    // A cause the plant does not know stays UNCODED, so that someone codes it.
    expect(classifyCause(config.reasons.rules, 'Down', 'NEW-FAULT')).toBe(UNCODED);
  });

  it('hold the groups of the Phase 5 plan', () => {
    const top = config.reasons.reasons.filter((r) => parentReason(r.id) === null).map((r) => r.id);
    expect(top).toEqual([
      'BREAKDOWN',
      'MINOR-STOP',
      'SETUP',
      'ORGANISATION',
      'MATERIAL',
      'STARVED',
      'BLOCKED',
      'PLANNED',
      'UNCODED',
    ]);
  });
});

describe('the reasons cross-check (#119)', () => {
  it.each<[string, (c: PlantConfig) => void, string]>([
    [
      'a rule naming an unknown reason',
      (c) => {
        c.reasons.rules.unshift({ state: 'Down', cause: 'X', reason: 'BREAKDOWN/NOPE' });
      },
      'reasons:rules[0]: unknown reason "BREAKDOWN/NOPE"',
    ],
    [
      'a child listed before its parent',
      (c) => {
        c.reasons.reasons.unshift({ id: 'LATE/CHILD', name: 'Child' });
        c.reasons.reasons.push({ id: 'LATE', name: 'Parent' });
      },
      'reasons:reasons[0]: parent "LATE" must be listed before "LATE/CHILD"',
    ],
    [
      'a duplicate reason',
      (c) => {
        c.reasons.reasons.push({ id: 'BLOCKED', name: 'Again' });
      },
      'duplicate reason "BLOCKED"',
    ],
    [
      'no UNCODED reason',
      (c) => {
        c.reasons.reasons = c.reasons.reasons.filter((r) => r.id !== UNCODED);
      },
      'the reason "UNCODED" is missing',
    ],
    [
      'a loss state without a fallback for no cause',
      (c) => {
        c.reasons.rules = c.reasons.rules.filter((r) => !(r.state === 'Setup' && r.cause === null));
      },
      'no rule for Setup with no cause (a fallback)',
    ],
    [
      'a failure code no rule codes',
      (c) => {
        c.failures.equipment['pck-01']?.failureModes.push({
          code: 'INK-OUT',
          weibullShape: 1,
          weibullScaleHours: 100,
          repairMedianMinutes: 5,
          repairSpread: 0.5,
        });
      },
      'no rule codes Down with "INK-OUT"',
    ],
    [
      'a material no rule codes',
      (c) => {
        c.reasons.rules = c.reasons.rules.filter(
          (r) => !(typeof r.cause === 'object' && r.cause !== null && 'prefix' in r.cause),
        );
      },
      'no rule codes Starved with "MATERIAL:BLANK-100"',
    ],
    [
      'a malformed cause pattern',
      (c) => {
        Object.assign(c.reasons.rules[0] ?? {}, { cause: { suffix: 'X' } });
      },
      'reasons:rules.0.cause',
    ],
    [
      'an unknown state',
      (c) => {
        Object.assign(c.reasons.rules[0] ?? {}, { state: 'Broken' });
      },
      'reasons:rules.0.state',
    ],
  ])('reports %s', (_case, change, expected) => {
    expect(messagesFor(change)).toContain(expected);
  });
});
