import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { determinismRules } from './determinism-rules.ts';

const eslint = new ESLint({
  cwd: resolve(import.meta.dirname, '../../..'),
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ...determinismRules(),
  ],
});

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

describe('determinism rules (plan section 4)', () => {
  it.each([
    ['Math.random()', 'no-restricted-properties'],
    ['Date.now()', 'no-restricted-properties'],
    ['performance.now()', 'no-restricted-properties'],
    ['Temporal.Now.instant()', 'no-restricted-properties'],
    ['crypto.randomUUID()', 'no-restricted-properties'],
    ['crypto.getRandomValues(new Uint8Array(4))', 'no-restricted-properties'],
    ['new Date()', 'no-restricted-syntax'],
    ['Date()', 'no-restricted-syntax'],
  ])('rejects %s in sim-core and the plant model', async (code, rule) => {
    expect(await ruleIds('packages/sim-core/src/a.ts', `${code};\n`)).toEqual([rule]);
    expect(await ruleIds('apps/simulator/src/plant/a.ts', `${code};\n`)).toEqual([rule]);
  });

  it.each(['Date.UTC(2026, 9, 12)', 'new Date(0)', 'Temporal.Instant.fromEpochMilliseconds(0)'])(
    'allows %s, which does not read the clock',
    async (code) => {
      expect(await ruleIds('packages/sim-core/src/a.ts', `${code};\n`)).toEqual([]);
    },
  );

  it('does not apply outside deterministic code', async () => {
    expect(await ruleIds('apps/simulator/src/headless/cli.ts', 'Date.now();\n')).toEqual([]);
  });
});
