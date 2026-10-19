import { resolve } from 'node:path';
import { z } from 'zod';
import { MAX_SPEED, MIN_SPEED } from '../live/pacer.ts';
import { PRODUCTION_MODES } from '../plant/line.ts';

const DEFAULT_CONFIG = resolve(import.meta.dirname, '../../../../config/plant');
const DEFAULT_SCENARIOS = resolve(import.meta.dirname, '../../../../config/scenarios');

const integer = z
  .string()
  .regex(/^\d{1,10}$/, 'expected a decimal integer')
  .transform(Number);
const port = integer.pipe(z.number().min(1).max(65_535));
const text = z.string().trim().min(1);

export const envSchema = z.object({
  SIM_SEED: integer.pipe(z.number().max(2 ** 32 - 1)).default(1),
  SIM_SPEED: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'expected a decimal number')
    .transform(Number)
    .pipe(z.number().min(MIN_SPEED).max(MAX_SPEED))
    .default(60),
  SIM_START: z
    .string()
    .default('2026-10-12T06:00:00+03:00')
    .transform((value, context) => {
      try {
        return Temporal.Instant.from(value).epochMilliseconds;
      } catch {
        context.addIssue({ code: 'custom', message: 'expected ISO 8601 with an offset' });
        return z.NEVER;
      }
    }),
  SIM_CONFIG_DIR: text.default(DEFAULT_CONFIG),
  /**
   * A stock file in place of `SIM_CONFIG_DIR/stock.yaml` (#196, ADR-0033), e.g. a golden
   * scenario's own `stock.yaml` for a live run of that scenario. Left out, the configuration's.
   */
  SIM_STOCK: text.optional(),
  SIM_AUTOSTART: z.enum(['true', 'false']).default('true'),
  /** `schedule` (default, Phases 1–6) or `orders` (#172): CNCs run only `LoadOrder` jobs. */
  SIM_PRODUCTION: z.enum(PRODUCTION_MODES).default('schedule'),
  /**
   * A timeline loaded before the run starts (#235): a name of `SIM_SCENARIOS_DIR` or a file path.
   * Its seed, start and production mode must be the run's; a `dispatch` entry is refused.
   */
  SIM_TIMELINE: text.optional(),
  /** The committed timelines (`POST /scenario` by name, `GET /scenarios`). */
  SIM_SCENARIOS_DIR: text.default(DEFAULT_SCENARIOS),
  /** A file the live event log is written to (#235): the headless `events.jsonl` without header. */
  SIM_EVENT_LOG: text.optional(),
  OPCUA_HOST: text.default('localhost'),
  OPCUA_PORT_OFFSET: integer.pipe(z.number().max(9_999)).default(0),
  OPCUA_PKI_DIR: text.optional(),
  MODBUS_HOST: text.default('127.0.0.1'),
  MODBUS_PORT: port.default(5020),
  CONTROL_HOST: text.default('127.0.0.1'),
  CONTROL_PORT: port.default(4800),
  /**
   * The control API's bearer token (#237, control API 1.11): required on every route but
   * `/health/*` and `/metrics`. Random per stack, at least 16 characters, no whitespace.
   */
  /**
   * How long an event-stream connection lives before it is closed with 4100 (#237 review): the
   * console reconnects, and nginx checks the session again. 1 s to 1 h, default 5 min.
   */
  SIM_EVENTS_LIFETIME_MS: integer.pipe(z.number().min(1_000).max(3_600_000)).default(300_000),
  SIM_CONTROL_TOKEN: z
    .string()
    .regex(/^\S{16,512}$/, 'expected 16–512 characters without whitespace'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type SimulatorEnv = z.output<typeof envSchema>;

export type EnvResult =
  | { readonly ok: true; readonly env: SimulatorEnv }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Validates the environment; unknown variables are ignored, invalid ones are reported by name. */
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
      // A secret is never echoed (#237).
      const shown = key.includes('TOKEN') ? '(hidden)' : JSON.stringify(known[key] ?? null);
      return `${issue.path.join('.')}: ${issue.message} (got ${shown})`;
    }),
  };
}
