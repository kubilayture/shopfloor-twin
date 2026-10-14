import type { Linter } from 'eslint';

export const DETERMINISTIC_SOURCES = ['packages/sim-core/src', 'apps/simulator/src/plant'] as const;

const why =
  'Deterministic code must not read the wall clock or unseeded randomness; use simulation time and a seeded random stream (plan section 4).';

const forbiddenProperties: [string, string][] = [
  ['Math', 'random'],
  ['Date', 'now'],
  ['performance', 'now'],
  ['Temporal', 'Now'],
  ['crypto', 'randomUUID'],
  ['crypto', 'getRandomValues'],
];

export function determinismRules(): Linter.Config[] {
  return [
    {
      files: DETERMINISTIC_SOURCES.flatMap((dir) => [`${dir}/**/*.ts`, `${dir}/**/*.tsx`]),
      rules: {
        'no-restricted-properties': [
          'error',
          ...forbiddenProperties.map(([object, property]) => ({ object, property, message: why })),
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: "NewExpression[callee.name='Date'][arguments.length=0]",
            message: why,
          },
          {
            selector: "CallExpression[callee.name='Date']",
            message: why,
          },
        ],
      },
    },
  ];
}
