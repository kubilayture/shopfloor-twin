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
  PLANT_CONFIG_DIR: text.default(resolve(REPO, 'config/plant')),
  HTTP_HOST: text.default('127.0.0.1'),
  HTTP_PORT: port.default(4700),
  // Host headers the API answers (DNS rebinding): comma-separated host names, `*` for any.
  HTTP_ALLOWED_HOSTS: text.default('localhost,127.0.0.1,[::1]'),
  // Origins (scheme://host[:port]) a WebSocket may connect from besides the MES's own host;
  // a request without Origin (not a browser) is always allowed. Comma-separated, default none.
  HTTP_ALLOWED_ORIGINS: z.string().trim().default(''),
  // The API's own read pool, so dashboard reads never hold up ingest's writes.
  API_DB_POOL_SIZE: integer.pipe(z.number().min(1).max(50)).default(4),
  API_STATEMENT_TIMEOUT_MS: integer.pipe(z.number().min(100)).default(5_000),
  // The UNS (#95): a persistent session as user `mes`; the password is MQTT_MES_PASSWORD of .env
  // (the Compose service that passes it arrives with #99).
  MQTT_URL: z.url({ protocol: /^mqtts?$/ }).default('mqtt://127.0.0.1:1883'),
  MQTT_USERNAME: text.default('mes'),
  MQTT_PASSWORD: z.string().min(1),
  MQTT_CLIENT_ID: text.default('mes-server'),
  // How long the broker keeps the session (and queues messages) while the MES is away: 7 days.
  MQTT_SESSION_EXPIRY_S: integer.pipe(z.number().min(60)).default(604_800),
  // How long a sequence hole may stay open (wall time) before it is recorded as an incident.
  INGEST_GAP_GRACE_MS: integer.pipe(z.number().min(0)).default(30_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type MesEnv = z.output<typeof envSchema>;

export type EnvResult =
  | { readonly ok: true; readonly env: MesEnv }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Secrets, or URLs that may carry them, are never echoed. */
const HIDDEN = new Set(['DATABASE_URL', 'MQTT_URL', 'MQTT_PASSWORD']);

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
        HIDDEN.has(key) || key.includes('PASSWORD')
          ? '(hidden)'
          : JSON.stringify(known[key] ?? null);
      return `${issue.path.join('.')}: ${issue.message} (got ${shown})`;
    }),
  };
}
