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
    ['a pure package test imports vitest', 'packages/sim-core/src/a.test.ts', 'vitest'],
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
