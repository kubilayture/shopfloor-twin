# ADR-0005: Enforce dependency rules with ESLint's no-restricted-imports

- Status: accepted; amended 2026-10-16 by ADR-0024 (pure packages may import other pure packages by name)
- Date: 2026-10-11
- Deciders: Claude, owner on review

## Context and problem statement

Plan section 8 lists four dependency rules that lint must enforce: packages never import apps; `sim-core` and `oee-core` have no I/O or framework dependencies; apps share data only through `contracts`; MES modules import each other only through `index.ts`. Which tool enforces them?

## Considered options

1. `eslint-plugin-boundaries` 7.2: purpose-built architecture rules with element types and policies.
2. ESLint's built-in `no-restricted-imports` rule with regex patterns, scoped per folder.

## Decision outcome

Chosen option: 2.

- Every rule in plan section 8 is a statement about import specifiers (`@shopfloor/<app>`, `node:*`, `../<module>/…`), which a regex scoped by file glob expresses exactly.
- Workspace packages are imported by name; option 1 would also need an import resolver (`eslint-import-resolver-typescript`) to map names to folders, adding two dependencies and a resolution step that can silently fail.
- The rules live in `packages/eslint-config/src/dependency-rules.ts`, about 90 lines, and every rule has a passing and a failing case in `dependency-rules.test.ts`.

Known limitation: ESLint replaces, not merges, a rule's options when several config objects match one file, so each folder scope lists its full set of patterns. The tests catch a scope that forgets one.

The pure-package rule is an allowlist: `sim-core` and `oee-core` source files may import only relative paths. Test files are exempt so they can import `vitest` and `fast-check`. Allowing any other import needs an ADR.

_Amended by ADR-0024 (#139):_ the pure packages are now `sim-core`, `oee-core`, `shift-calendar` and `alarm-core`, and a pure package may also import another pure package by its exact name (`@shopfloor/oee-core`), never a subpath, a non-pure workspace package or an app. Purity stays transitive.

_Amended by ADR-0032 (#195):_ `spc-core` and `trace-core` join the pure packages (`spc-core` imports `oee-core` for its fractions, `trace-core` imports `spc-core`), with failing and passing cases for both in `dependency-rules.test.ts`.

### Consequences

- Good: no extra dependencies; the rules are readable regular expressions with plain-language messages that cite the plan.
- Bad: rules are path-based, so moving folders means updating globs; the tests cover this.
- Revisit if rules start depending on what a module exports rather than where it lives.
