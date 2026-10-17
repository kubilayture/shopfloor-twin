import { resolve } from 'node:path';
import { PASSWORD_LENGTH, passwordLength } from '@shopfloor/contracts/identity';
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
  // Origins (scheme://host[:port]) a WebSocket may connect from, or a write may come from,
  // besides the MES's own host; a read or WebSocket without Origin (not a browser) is allowed, a
  // write without one is not (ADR-0023). Comma-separated, default none.
  HTTP_ALLOWED_ORIGINS: z.string().trim().default(''),
  // Writes (#121, ADR-0023): `off` answers every non-GET request under /api/v1 with 405.
  MES_WRITES: z.enum(['on', 'off']).default('on'),
  // Identity (#168, ADR-0026): `on` needs a session on every /api/v1 route but the login, and on
  // the WebSocket; `off` (the default until #170) serves everyone as before and logs a warning.
  MES_AUTH: z.enum(['on', 'off']).default('off'),
  // `on` marks the session cookie `Secure` and names it `__Host-sft_session` (behind TLS only).
  MES_COOKIE_SECURE: z.enum(['on', 'off']).default('off'),
  // Optional: creates the user `admin` (must change its password) when no enabled admin exists.
  MES_BOOTSTRAP_ADMIN_PASSWORD: z
    .string()
    .refine(
      (value) =>
        passwordLength(value) >= PASSWORD_LENGTH.min &&
        passwordLength(value) <= PASSWORD_LENGTH.max,
      `expected ${String(PASSWORD_LENGTH.min)}–${String(PASSWORD_LENGTH.max)} characters`,
    )
    .optional(),
  // The API's own read pool, so dashboard reads never hold up ingest's writes.
  API_DB_POOL_SIZE: integer.pipe(z.number().min(1).max(50)).default(4),
  API_STATEMENT_TIMEOUT_MS: integer.pipe(z.number().min(100)).default(5_000),
  // The UNS (#95): a persistent session as user `mes`; the password is MQTT_MES_PASSWORD of .env,
  // which the Compose service `mes` passes (#99).
  MQTT_URL: z.url({ protocol: /^mqtts?$/ }).default('mqtt://127.0.0.1:1883'),
  MQTT_USERNAME: text.default('mes'),
  MQTT_PASSWORD: z.string().min(1),
  MQTT_CLIENT_ID: text.default('mes-server'),
  // How long the broker keeps the session (and queues messages) while the MES is away: 7 days.
  MQTT_SESSION_EXPIRY_S: integer.pipe(z.number().min(60)).default(604_800),
  // How long a sequence hole may stay open (wall time) before it is recorded as an incident.
  INGEST_GAP_GRACE_MS: integer.pipe(z.number().min(0)).default(30_000),
  // The ERP (#174, ADR-0028): its base URL and the shared bearer token. Without ERP_URL the MES
  // imports no orders and posts nothing (its outbox keeps the messages).
  ERP_URL: z.url({ protocol: /^https?$/ }).optional(),
  ERP_API_TOKEN: z.string().regex(/^\S+$/, 'non-empty, without whitespace').optional(),
  // How often the ERP's order feed is pulled (wall time).
  ERP_POLL_MS: integer.pipe(z.number().min(100)).default(10_000),
  // The command path (#174, ADR-0029): a delivery's life (`expiresAt`), how long a delivery
  // without an answer waits before a resend, deliveries at most, and the margin after the last
  // `expiresAt` before a command without a final answer is `failed`.
  COMMAND_TTL_MS: integer.pipe(z.number().min(1_000)).default(60_000),
  COMMAND_RESEND_MS: integer.pipe(z.number().min(100)).default(15_000),
  COMMAND_ATTEMPTS: integer.pipe(z.number().min(1).max(20)).default(5),
  COMMAND_FAIL_MARGIN_MS: integer.pipe(z.number().min(0)).default(30_000),
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
    // `*` answers any Host, which turns off the DNS-rebinding check: with writes on, a page on a
    // rebound name would be same-origin and could write (ADR-0023).
    const anyHost = result.data.HTTP_ALLOWED_HOSTS.split(',').some((host) => host.trim() === '*');
    if (result.data.ERP_URL !== undefined && result.data.ERP_API_TOKEN === undefined) {
      return { ok: false, issues: ['ERP_API_TOKEN: required with ERP_URL (got (hidden))'] };
    }
    if (anyHost && result.data.MES_WRITES === 'on') {
      return {
        ok: false,
        issues: [
          'HTTP_ALLOWED_HOSTS: `*` turns off the DNS-rebinding check; not allowed while MES_WRITES=on (got "*")',
        ],
      };
    }
    return { ok: true, env: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const key = String(issue.path[0]);
      const shown =
        HIDDEN.has(key) || key.includes('PASSWORD') || key.includes('TOKEN')
          ? '(hidden)'
          : JSON.stringify(known[key] ?? null);
      return `${issue.path.join('.')}: ${issue.message} (got ${shown})`;
    }),
  };
}

/**
 * The `migrate` step's environment (#169, ADR-0027): it connects as the bootstrap superuser
 * (`DATABASE_URL`, password in `PGPASSWORD`), creates the roles and sets `mes_app`'s password from
 * `DB_APP_PASSWORD` when given (Compose requires it). Nothing of the MES's own settings.
 */
export const migrateEnvSchema = z.object({
  DATABASE_URL: envSchema.shape.DATABASE_URL,
  MIGRATIONS_DIR: envSchema.shape.MIGRATIONS_DIR,
  // Printable ASCII: migrate sends only its SCRAM verifier, made without SASLprep.
  DB_APP_PASSWORD: z
    .string()
    .regex(/^[\x20-\x7e]+$/, 'expected printable ASCII')
    .optional(),
});

export type MigrateEnv = z.output<typeof migrateEnvSchema>;

/** Validates the `migrate` step's environment; secrets are never echoed. */
export function parseMigrateEnv(
  source: Readonly<Record<string, string | undefined>>,
):
  | { readonly ok: true; readonly env: MigrateEnv }
  | { readonly ok: false; readonly issues: readonly string[] } {
  const known = Object.fromEntries(
    Object.keys(migrateEnvSchema.shape).flatMap((key) => {
      const value = source[key];
      return value === undefined || value === '' ? [] : [[key, value]];
    }),
  );
  const result = migrateEnvSchema.safeParse(known);
  if (result.success) return { ok: true, env: result.data };
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
