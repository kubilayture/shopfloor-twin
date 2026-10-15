import { resolve } from 'node:path';
import { z } from 'zod';

const DEFAULT_CONFIG = resolve(import.meta.dirname, '../../../config/plant');

const integer = z
  .string()
  .regex(/^\d{1,10}$/, 'expected a decimal integer')
  .transform(Number);
const port = integer.pipe(z.number().min(1).max(65_535));
const text = z.string().trim().min(1);

export const envSchema = z.object({
  GATEWAY_ID: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lower-case kebab-case')
    .default('gw-01'),
  PLANT_CONFIG_DIR: text.default(DEFAULT_CONFIG),
  MQTT_URL: z.url({ protocol: /^mqtts?$/ }).default('mqtt://127.0.0.1:1883'),
  MQTT_USERNAME: text.default('gw-01'),
  // Not trimmed: spaces may be part of a password.
  MQTT_PASSWORD: z.string().min(1),
  HTTP_HOST: text.default('127.0.0.1'),
  HTTP_PORT: port.default(4900),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type GatewayEnv = z.output<typeof envSchema>;

export type EnvResult =
  | { readonly ok: true; readonly env: GatewayEnv }
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
      const shown = key.includes('PASSWORD') ? '(hidden)' : JSON.stringify(known[key] ?? null);
      return `${issue.path.join('.')}: ${issue.message} (got ${shown})`;
    }),
  };
}
