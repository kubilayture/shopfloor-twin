# Dependencies

Every third-party dependency and why it exists. A dependency is not added without a row here (plan section 6).

| Package                  | Used in             | Why                                                                                                                                                                              |
| ------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript`             | all packages        | Type checking (`tsc --noEmit`); Node.js runs the sources directly (ADR-0003)                                                                                                     |
| `turbo`                  | root                | Runs `typecheck` and `test` per package in dependency order, with caching                                                                                                        |
| `prettier`               | root                | One formatting style for code, JSON, YAML and Markdown; checked in `pnpm verify`                                                                                                 |
| `vitest`                 | packages with tests | Unit, property and integration test runner across the monorepo (plan section 9)                                                                                                  |
| `@types/node`            | all packages        | Types for Node.js built-ins                                                                                                                                                      |
| `eslint`                 | all packages        | Linter; runs the type-aware rules and the dependency rules of plan section 8                                                                                                     |
| `@eslint/js`             | `eslint-config`     | ESLint's recommended JavaScript rules                                                                                                                                            |
| `typescript-eslint`      | `eslint-config`     | TypeScript parser and type-checked rules (`no-floating-promises`, `no-explicit-any`, …)                                                                                          |
| `eslint-config-prettier` | `eslint-config`     | Turns off lint rules that conflict with Prettier's formatting                                                                                                                    |
| `globals`                | `eslint-config`     | Declares Node.js global variables for ESLint                                                                                                                                     |
| `lefthook`               | root                | Git pre-commit hook: formats and lints staged files. Its install script is denied in `pnpm-workspace.yaml` (`allowBuilds`); the root `prepare` script installs the hooks instead |
