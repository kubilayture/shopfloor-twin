# ADR-0003: Monorepo layout and TypeScript without a build step

- Status: accepted
- Date: 2026-10-10
- Deciders: owner (plan section 8), Claude (build approach)

## Context and problem statement

Plan section 8 fixes the folder layout: `apps/*` for runtime components, `packages/*` for shared code, plus `config/`, `db/`, `e2e/` and `docs/`. Open: how shared packages are consumed. Either each package compiles to JavaScript before others can use it, or consumers read its TypeScript source directly.

## Considered options

1. Compiled packages: each package runs `tsc` to `dist/`, with project references.
2. Source packages: each package exports its `.ts` files; Node.js 26 runs TypeScript directly by stripping types; `tsc` only type-checks.

## Decision outcome

Chosen option: 2, source packages.

- Package names use the `@shopfloor/` scope; internal dependencies use `workspace:*`.
- A package's `exports` point at `src/index.ts`. Relative imports carry the `.ts` extension, as Node.js type stripping requires.
- The shared `@shopfloor/tsconfig/base.json` enables `erasableSyntaxOnly`, which rejects TypeScript features that need code generation (`enum`, `namespace`, constructor parameter properties) because Node.js cannot strip them. Use `as const` objects and union types instead of enums.
- `tsc` runs with `noEmit` as the `typecheck` task. Turborepo runs `typecheck` and `test` per package, dependencies first.
- Docker images for apps (Phase 2 onward) copy sources and run them with Node.js; whether to bundle for production is decided then.

### Consequences

- Good: no build step or `dist/` to keep in sync; editing a package is immediately visible to its consumers and tests.
- Good: the code that runs is the code that was reviewed, minus types.
- Bad: no TypeScript-only runtime features (enums, decorators with metadata). Acceptable: the plan's style (Zod schemas, union types) does not need them.
- Bad: packages cannot be published to npm as-is. Not a goal.
