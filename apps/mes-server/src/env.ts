import { resolve } from 'node:path';
import { z } from 'zod';

const REPO = resolve(import.meta.dirname, '../../..');

const integer = z
  .string()
  .regex(/^\d{1,10}$/, 'expected a decimal integer')
  .transform(Number);
const port = integer.pipe(z.number().min(1).max(65_535));
const text = z.string().trim().min(1);

export const envSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  MIGRATIONS_DIR: text.default(resolve(REPO, 'db/migrations')),
  HTTP_HOST: text.default('127.0.0.1'),
  HTTP_PORT: port.default(4700),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type MesEnv = z.output<typeof envSchema>;

export type EnvResult =
  | { readonly ok: true; readonly env: MesEnv }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Validates the environment; secrets (the database URL carries a password) are never echoed. */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): EnvResult {
  const known = Object.fromEntries(
    Object.keys(envSchema.shape).flatMap((key) => {
      const value = source[key];
      return value === undefined || value === '' ? [] : [[key, value]];
    }),
  );
  const result = envSchema.safeParse(known);
  if (result.success) {
    return { ok: true, env: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const key = String(issue.path[0]);
      const shown =
        key === 'DATABASE_URL' || key.includes('PASSWORD')
          ? '(hidden)'
          : JSON.stringify(known[key] ?? null);
      return `${issue.path.join('.')}: ${issue.message} (got ${shown})`;
    }),
  };
}
