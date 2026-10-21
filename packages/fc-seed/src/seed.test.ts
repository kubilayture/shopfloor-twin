import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, inject, test } from 'vitest';
import { drawSeed, parseSeed, resolveSeed, seedLine } from './index.ts';

describe('parseSeed', () => {
  test('unset or empty: no pinned seed', () => {
    expect(parseSeed(undefined)).toBeUndefined();
    expect(parseSeed('')).toBeUndefined();
    expect(parseSeed('  ')).toBeUndefined();
  });

  test('a 32-bit signed integer', () => {
    expect(parseSeed('0')).toBe(0);
    expect(parseSeed(' 42 ')).toBe(42);
    expect(parseSeed('-7')).toBe(-7);
    expect(parseSeed('2147483647')).toBe(2147483647);
    expect(parseSeed('-2147483648')).toBe(-2147483648);
  });

  test.each([
    'abc',
    '1.5',
    '1e3',
    '0x10',
    '2147483648',
    '-2147483649',
    '12abc',
    '-0',
    '007',
    '-01',
  ])('refuses %s', (raw) => {
    expect(() => parseSeed(raw)).toThrow(/FC_SEED must be an integer/);
  });
});

test('resolveSeed: FC_SEED wins, else a drawn seed in range', () => {
  expect(resolveSeed('123')).toBe(123);
  for (let i = 0; i < 100; i += 1) {
    const seed = drawSeed();
    expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 31).toBe(true);
  }
  expect(new Set(Array.from({ length: 20 }, () => resolveSeed(undefined))).size).toBeGreaterThan(1);
});

test('the seed line', () => {
  expect(seedLine('@shopfloor/sim-core', 42)).toBe(
    'fast-check seed @shopfloor/sim-core: 42 (FC_SEED=42 reproduces)',
  );
});

describe('in this workspace', () => {
  test('fast-check runs with the seed the global setup provided', () => {
    expect(fc.readConfigureGlobal().seed).toBe(inject('fcSeed'));
  });

  test('an explicit seed wins over the global one', () => {
    const saved = fc.readConfigureGlobal();
    try {
      fc.configureGlobal({ ...saved, seed: 1 });
      const underOne = fc.sample(fc.integer(), 10);
      const explicitUnderOne = fc.sample(fc.integer(), { numRuns: 10, seed: 156 });
      fc.configureGlobal({ ...saved, seed: 2 });
      expect(fc.sample(fc.integer(), 10)).not.toEqual(underOne);
      expect(fc.sample(fc.integer(), { numRuns: 10, seed: 156 })).toEqual(explicitUnderOne);
    } finally {
      fc.configureGlobal(saved);
    }
  });
});

/** The repository's workspace directories, from `pnpm-workspace.yaml`'s `packages` globs. */
function workspaceDirs(root: string): string[] {
  const lines = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'packages:');
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+-\s+['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (match?.[1] === undefined) break;
    globs.push(match[1]);
  }
  return globs.flatMap((glob) => {
    if (!glob.endsWith('/*')) return [glob];
    const parent = glob.slice(0, -2);
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`);
  });
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe('registration guard', () => {
  const root = join(import.meta.dirname, '..', '..', '..');
  const users = workspaceDirs(root)
    .filter((dir) => existsSync(join(root, dir, 'package.json')))
    .map((dir) => ({
      dir,
      manifest: JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as Manifest,
    }))
    .filter(
      ({ manifest }) =>
        manifest.name !== '@shopfloor/fc-seed' &&
        ('fast-check' in (manifest.dependencies ?? {}) ||
          'fast-check' in (manifest.devDependencies ?? {})),
    );

  test('finds the workspaces that use fast-check (at least the nine of P10-01)', () => {
    expect(users.map(({ dir }) => dir)).toEqual(
      expect.arrayContaining([
        'apps/mes-server',
        'apps/simulator',
        'packages/alarm-core',
        'packages/contracts',
        'packages/oee-core',
        'packages/shift-calendar',
        'packages/sim-core',
        'packages/spc-core',
        'packages/trace-core',
      ]),
    );
  });

  test('every workspace that uses fast-check registers the seed pair', () => {
    const problems = users.flatMap(({ dir, manifest }) => {
      const found: string[] = [];
      if (manifest.devDependencies?.['@shopfloor/fc-seed'] !== 'workspace:*') {
        found.push(`${dir}: no devDependency "@shopfloor/fc-seed": "workspace:*"`);
      }
      const configFile = join(root, dir, 'vitest.config.ts');
      const config = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
      if (!config.includes('...fcSeed')) found.push(`${dir}: vitest.config.ts lacks ...fcSeed`);
      // A key of its own after the spread would replace the pair.
      if (/\b(setupFiles|globalSetup)\s*:/.test(config)) {
        found.push(`${dir}: vitest.config.ts sets setupFiles or globalSetup itself`);
      }
      return found;
    });
    expect(problems).toEqual([]);
  });
});
