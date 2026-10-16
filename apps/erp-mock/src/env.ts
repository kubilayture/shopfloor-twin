import { resolve } from 'node:path';
import { z } from 'zod';

const REPO = resolve(import.meta.dirname, '../../..');

const integer = z
  .string()
  .regex(/^\d{1,10}$/, 'expected a decimal integer')
  .transform(Number);
const port = integer.pipe(z.number().min(1).max(65_535));
const text = z.string().trim().min(1);

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const envSchema = z.object({
  // Not trimmed: the token is compared byte for byte.
  ERP_API_TOKEN: z.string().min(1),
  ERP_DATASET: text.default(resolve(REPO, 'config/erp/orders.yaml')),
  PLANT_CONFIG_DIR: text.default(resolve(REPO, 'config/plant')),
  ERP_STORE_PATH: text.default('.store/erp.db'),
  /** The dev-only `POST /api/v1/orders` (ADR-0028). */
  ERP_ADMIN: z.enum(['on', 'off']).default('off'),
  HTTP_HOST: text.default('127.0.0.1'),
  HTTP_PORT: port.default(4600),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type ErpEnv = z.output<typeof envSchema>;

export type EnvResult =
  | { readonly ok: true; readonly env: ErpEnv }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Validates the environment; unknown variables are ignored, invalid ones reported by name (never the value of a secret). */
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
      const shown = key.includes('TOKEN') ? '(hidden)' : JSON.stringify(known[key] ?? null);
      return `${issue.path.join('.')}: ${issue.message} (got ${shown})`;
    }),
  };
}

/** A token too short to be a real secret, or the `.env.example` placeholder: worth a warning. */
export const isWeakToken = (token: string): boolean => token.length < 16 || token === 'change-me';
