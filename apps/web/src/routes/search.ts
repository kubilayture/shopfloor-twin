// Search parameter checks shared by the route files (ADR-0020: validated search parameters).

export const SHIFT_KEY = /^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]{1,16}$/;
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}~\d{1,15}~\d{1,15}$/;

/** The value when it is a string matching the pattern, else undefined. */
export const matching = (value: unknown, pattern: RegExp): string | undefined =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;
