import type { LOG_LEVELS } from './env.ts';

export type LogLevel = (typeof LOG_LEVELS)[number];
type Fields = Readonly<Record<string, unknown>>;

/** pino's numeric levels, so the lines read like the other services' logs. */
const NUMBERS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
};

export interface Logger {
  debug(fields: Fields, msg: string): void;
  info(fields: Fields, msg: string): void;
  warn(fields: Fields, msg: string): void;
  error(fields: Fields, msg: string): void;
}

/**
 * One JSON object per line on stdout, pino's shape (`level`, `time`, `msg`), without a dependency.
 * Callers never pass a header, a body or the token, so none reaches the log.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stdout.write(line),
): Logger {
  const threshold = NUMBERS[level];
  const at =
    (name: Exclude<LogLevel, 'silent'>) =>
    (fields: Fields, msg: string): void => {
      const n = NUMBERS[name];
      if (n < threshold) return;
      const error = fields.err instanceof Error ? { err: { message: fields.err.message } } : {};
      write(`${JSON.stringify({ level: n, time: Date.now(), ...fields, ...error, msg })}\n`);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
