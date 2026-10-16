import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { exactnessRules } from './exactness-rules.ts';

const eslint = new ESLint({
  cwd: resolve(import.meta.dirname, '../../..'),
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ...exactnessRules(),
  ],
});

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

describe('exactness rules (ADR-0021)', () => {
  it.each([
    'Math.floor(7 / 2)',
    'Math.round(x)',
    'const half = 0.5',
    'const half = .5',
    'const big = 1e3',
    'const big = 12_000e-3',
    'const ratio = a / b',
    'x /= 2',
    'const tiny = 2 ** -1',
    'parseFloat("1.5")',
    'x.toFixed(4)',
  ])('rejects %s in oee-core', async (code) => {
    expect(await ruleIds('packages/oee-core/src/a.ts', `${code};\n`)).toContain(
      'no-restricted-syntax',
    );
  });

  it.each([
    'const n = 3_600_000',
    'const b = 10n ** 4n',
    'const r = a % b',
    'const s = "0.5 / 2"',
    'const h = 0xe5',
    'const p = 2 ** 10',
  ])('allows %s, which is integer arithmetic', async (code) => {
    expect(await ruleIds('packages/oee-core/src/a.ts', `${code};\n`)).toEqual([]);
  });

  it('applies to alarm-core too (ADR-0024)', async () => {
    expect(await ruleIds('packages/alarm-core/src/a.ts', 'const r = a / b;\n')).toContain(
      'no-restricted-syntax',
    );
  });

  it('does not apply to tests or outside oee-core and alarm-core', async () => {
    expect(await ruleIds('packages/oee-core/src/a.test.ts', 'Math.floor(1 / 2);\n')).toEqual([]);
    expect(await ruleIds('packages/sim-core/src/a.ts', 'Math.floor(1 / 2);\n')).toEqual([]);
  });
});
