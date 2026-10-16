export const EVENT_SCHEMA = 'sim-event/1';
export const RUN_SCHEMA = 'sim-run/1';
export const SUMMARY_SCHEMA = 'sim-summary/3';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonical(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`cannot serialize non-finite number ${String(value)}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === 'object' && isPlainObject(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
  }
  throw new TypeError(`cannot serialize ${Object.prototype.toString.call(value)}`);
}

export function stableStringify(value: unknown, indent?: number): string {
  return JSON.stringify(canonical(value), null, indent);
}

export const isoTime = (epochMs: number): string => new Date(epochMs).toISOString();
