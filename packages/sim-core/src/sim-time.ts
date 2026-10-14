export type SimTime = number;

export type Duration = number;

export const SECOND: Duration = 1_000;
export const MINUTE: Duration = 60 * SECOND;
export const HOUR: Duration = 60 * MINUTE;

export function assertSimTime(value: number, name = 'time'): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `${name} must be a safe integer number of milliseconds, got ${String(value)}`,
    );
  }
}
