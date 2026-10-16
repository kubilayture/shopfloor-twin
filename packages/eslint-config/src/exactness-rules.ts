import type { Linter } from 'eslint';

/** Code whose results must match exactly, as fractions and as four-decimal strings (ADR-0021). */
export const EXACT_SOURCES = ['packages/oee-core/src', 'packages/alarm-core/src'] as const;

const why =
  'oee-core and alarm-core are exact: integers and BigInt fractions only, no floating point (ADR-0021, ADR-0024). Divide bigints in oee-core/src/fraction.ts only.';

export function exactnessRules(): Linter.Config[] {
  return [
    {
      files: EXACT_SOURCES.flatMap((dir) => [`${dir}/**/*.ts`, `${dir}/**/*.tsx`]),
      ignores: ['**/*.test.ts', '**/*.test.tsx'],
      rules: {
        'no-restricted-syntax': [
          'error',
          { selector: "MemberExpression[object.name='Math']", message: why },
          { selector: "Identifier[name='parseFloat']", message: why },
          { selector: "MemberExpression[property.name='toFixed']", message: why },
          // A number literal with a decimal point or an exponent: 0.5, .5, 1e3.
          {
            selector: 'Literal[raw=/^(\\d[\\d_]*)?\\.\\d|^\\d[\\d_]*\\.?[\\d_]*[eE]/]',
            message: why,
          },
          // `/` on numbers yields floats; it cannot be told apart from bigint `/` without types.
          { selector: "BinaryExpression[operator='/']", message: why },
          { selector: "AssignmentExpression[operator='/=']", message: why },
          // A negative power of a number is a fraction: 2 ** -1.
          { selector: "BinaryExpression[operator='**'][right.operator='-']", message: why },
        ],
      },
    },
  ];
}
