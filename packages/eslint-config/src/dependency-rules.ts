import type { Linter } from 'eslint';

export const APPS = ['simulator', 'edge-gateway', 'mes-server', 'erp-mock', 'web'] as const;

export const PURE_PACKAGES = ['sim-core', 'oee-core', 'shift-calendar'] as const;

export const MES_MODULES = [
  'master-data',
  'ingest',
  'equipment',
  'oee',
  'alarms',
  'orders',
  'execution',
  'genealogy',
  'quality',
  'shifts',
  'identity',
  'realtime',
] as const;

interface RestrictedPattern {
  regex: string;
  message: string;
}

const anyOf = (names: readonly string[]): string => `(${names.join('|')})`;

function appImports(allowedApp?: string): RestrictedPattern {
  const forbidden = APPS.filter((app) => app !== allowedApp);
  return {
    regex: `^@shopfloor/${anyOf(forbidden)}(/|$)`,
    message: allowedApp
      ? 'Apps never import each other; share data only through @shopfloor/contracts (plan section 8).'
      : 'Packages never import from apps (plan section 8).',
  };
}

const relativeEscapeFromPackage: RestrictedPattern = {
  regex: '^(\\.\\./)+(apps|packages)/',
  message:
    'Do not reach into another package or app by relative path; import it by its @shopfloor/ name.',
};

const pureOnlyRelative: RestrictedPattern = {
  regex: '^[^.]',
  message:
    'sim-core, oee-core and shift-calendar are pure: no I/O, Node.js built-ins or third-party packages, only relative imports (plan section 8).',
};

const mesModuleInternals: RestrictedPattern = {
  regex: `^(\\.\\./)+${anyOf(MES_MODULES)}/(?!index\\.ts$)`,
  message: 'Import another MES module only through its index.ts (plan section 8).',
};

const restrict = (
  files: string[],
  patterns: RestrictedPattern[],
  ignores: string[] = [],
): Linter.Config => ({
  files,
  ignores,
  rules: { 'no-restricted-imports': ['error', { patterns }] },
});

const sourceFiles = (dir: string): string[] => [`${dir}/**/*.ts`, `${dir}/**/*.tsx`];

const TEST_FILES = ['**/*.test.ts', '**/*.test.tsx'];

export function dependencyRules(): Linter.Config[] {
  const packages = restrict(sourceFiles('packages/*'), [appImports(), relativeEscapeFromPackage]);

  const pure = PURE_PACKAGES.map((name) =>
    restrict(
      sourceFiles(`packages/${name}/src`),
      [appImports(), relativeEscapeFromPackage, pureOnlyRelative],
      TEST_FILES,
    ),
  );

  const apps = APPS.map((app) =>
    restrict(sourceFiles(`apps/${app}`), [appImports(app), relativeEscapeFromPackage]),
  );

  const mesModules = restrict(sourceFiles('apps/mes-server/src/modules'), [
    appImports('mes-server'),
    relativeEscapeFromPackage,
    mesModuleInternals,
  ]);

  return [packages, ...pure, ...apps, mesModules];
}
