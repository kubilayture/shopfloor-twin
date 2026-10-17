import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { dependencyRules } from './dependency-rules.ts';

const eslint = new ESLint({
  cwd: resolve(import.meta.dirname, '../../..'),
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser } },
    ...dependencyRules(),
  ],
});

async function violations(filePath: string, importSource: string): Promise<string[]> {
  const [result] = await eslint.lintText(`import '${importSource}';\n`, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

describe('dependency rules (plan section 8)', () => {
  it.each([
    ['a package imports an app', 'packages/contracts/src/a.ts', '@shopfloor/mes-server'],
    ['a package imports an app subpath', 'packages/contracts/src/a.ts', '@shopfloor/web/x'],
    ['an app imports another app', 'apps/simulator/src/a.ts', '@shopfloor/mes-server'],
    ['the MES imports the simulator', 'apps/mes-server/src/a.ts', '@shopfloor/simulator'],
    ['a relative path into another package', 'apps/web/src/a.ts', '../../../packages/x/y.ts'],
    ['a pure package imports a Node.js built-in', 'packages/sim-core/src/a.ts', 'node:fs'],
    ['a pure package imports a third-party package', 'packages/oee-core/src/a.ts', 'zod'],
    [
      'a pure package imports a workspace package',
      'packages/sim-core/src/a.ts',
      '@shopfloor/contracts',
    ],
    [
      'a pure package imports a non-pure workspace package (ADR-0024)',
      'packages/alarm-core/src/a.ts',
      '@shopfloor/plant-config',
    ],
    [
      'a pure package imports another pure package by subpath',
      'packages/alarm-core/src/a.ts',
      '@shopfloor/oee-core/src/fraction.ts',
    ],
    ['alarm-core imports a Node.js built-in', 'packages/alarm-core/src/a.ts', 'node:fs'],
    ['spc-core imports a Node.js built-in (ADR-0032)', 'packages/spc-core/src/a.ts', 'node:fs'],
    ['spc-core imports a third-party package', 'packages/spc-core/src/a.ts', 'zod'],
    [
      'spc-core imports a non-pure workspace package',
      'packages/spc-core/src/a.ts',
      '@shopfloor/plant-config',
    ],
    ['trace-core imports a Node.js built-in', 'packages/trace-core/src/a.ts', 'node:crypto'],
    [
      'trace-core imports a non-pure workspace package',
      'packages/trace-core/src/a.ts',
      '@shopfloor/contracts',
    ],
    [
      'trace-core imports spc-core by subpath',
      'packages/trace-core/src/a.ts',
      '@shopfloor/spc-core/src/chart.ts',
    ],
    [
      'a pure package reaches into spc-core by relative path',
      'packages/trace-core/src/a.ts',
      '../../../packages/spc-core/src/chart.ts',
    ],
    [
      'an MES module imports another module internals',
      'apps/mes-server/src/modules/oee/calc.ts',
      '../equipment/intervals.ts',
    ],
    [
      'an MES module imports deeper internals',
      'apps/mes-server/src/modules/oee/sub/calc.ts',
      '../../equipment/repo/sql.ts',
    ],
  ])('rejects: %s', async (_case, filePath, importSource) => {
    expect(await violations(filePath, importSource)).toEqual(['no-restricted-imports']);
  });

  it.each([
    ['a package imports contracts', 'packages/plant-config/src/a.ts', '@shopfloor/contracts'],
    ['an app imports contracts', 'apps/simulator/src/a.ts', '@shopfloor/contracts'],
    ['an app imports its own files', 'apps/simulator/src/engine/a.ts', '../../config/x.ts'],
    ['a pure package imports its own files', 'packages/sim-core/src/a.ts', './queue.ts'],
    [
      'a pure package imports another pure package by name (ADR-0024)',
      'packages/alarm-core/src/a.ts',
      '@shopfloor/oee-core',
    ],
    [
      'a pure package imports shift-calendar by name (ADR-0024)',
      'packages/oee-core/src/a.ts',
      '@shopfloor/shift-calendar',
    ],
    [
      'trace-core imports spc-core by name (ADR-0032: pure on pure)',
      'packages/trace-core/src/a.ts',
      '@shopfloor/spc-core',
    ],
    [
      'spc-core imports oee-core by name for its fractions',
      'packages/spc-core/src/a.ts',
      '@shopfloor/oee-core',
    ],
    ['a pure package test imports vitest', 'packages/sim-core/src/a.test.ts', 'vitest'],
    [
      'spc-core reference cases read the docs in a test',
      'packages/spc-core/src/reference-cases.test.ts',
      'node:fs',
    ],
    [
      'a pure package tool config imports vitest',
      'packages/sim-core/vitest.config.ts',
      'vitest/config',
    ],
    [
      'an MES module imports another module index',
      'apps/mes-server/src/modules/oee/calc.ts',
      '../equipment/index.ts',
    ],
    [
      'an MES module imports its own internals',
      'apps/mes-server/src/modules/oee/sub/calc.ts',
      '../rules.ts',
    ],
  ])('allows: %s', async (_case, filePath, importSource) => {
    expect(await violations(filePath, importSource)).toEqual([]);
  });
});
