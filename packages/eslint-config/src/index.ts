import js from '@eslint/js';
import type { Linter } from 'eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { dependencyRules } from './dependency-rules.ts';
import { determinismRules } from './determinism-rules.ts';

export { APPS, MES_MODULES, PURE_PACKAGES, dependencyRules } from './dependency-rules.ts';
export { DETERMINISTIC_SOURCES, determinismRules } from './determinism-rules.ts';

/** The browser app: browser globals and the rules of hooks instead of Node.js globals. */
export const WEB_SOURCES = ['apps/web/**/*.ts', 'apps/web/**/*.tsx'];

export interface ConfigOptions {
  rootDir: string;
}

export function createConfig({ rootDir }: ConfigOptions): Linter.Config[] {
  return [
    { ignores: ['**/node_modules/', '**/dist/', '**/coverage/', '**/.turbo/', '**/spikes/'] },
    { linterOptions: { reportUnusedDisableDirectives: 'error' } },
    js.configs.recommended,
    ...(tseslint.configs.strictTypeChecked as Linter.Config[]),
    ...(tseslint.configs.stylisticTypeChecked as Linter.Config[]),
    {
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir: rootDir },
      },
      rules: {
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        eqeqeq: ['error', 'always'],
      },
    },
    {
      files: ['**/*.js'],
      ...(tseslint.configs.disableTypeChecked as Linter.Config),
    },
    { ignores: WEB_SOURCES, languageOptions: { globals: globals.node } },
    {
      files: WEB_SOURCES,
      ...(reactHooks.configs.flat.recommended as Linter.Config),
      languageOptions: { globals: globals.browser },
    },
    ...dependencyRules(),
    ...determinismRules(),
    prettier,
  ];
}
