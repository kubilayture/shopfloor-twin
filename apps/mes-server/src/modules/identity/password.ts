import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt's cost parameters: N (a power of two), r and p. */
export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/**
 * N = 2^15, r = 8, p = 3: 32 MiB per hash (128 · N · r bytes), an OWASP-listed setting
 * (ADR-0026). Node's default `maxmem` is 32 MiB, which these parameters just exceed, so every call
 * passes `SCRYPT_MAXMEM` explicitly; without it the call fails.
 */
export const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };
export const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** At most `limit` callers at a time; the others wait in order. */
export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#active++;
    }
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }
}

/** At most two hashes at a time, so a burst of logins stays inside a 512 MiB container. */
const hashing = new Semaphore(2);

/** How many hashes run now (tests). */
export const hashesRunning = (): number => hashing.active;

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return hashing.run(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        scrypt(
          password.normalize('NFC'),
          salt,
          KEY_BYTES,
          { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
          (error, key) => {
            if (error) reject(error);
            else resolve(key);
          },
        );
      }),
  );
}

/** `scrypt$N$r$p$salt$hash`, salt and hash in base64 (no padding). */
export async function hashPassword(
  password: string,
  params: ScryptParams = SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return [
    'scrypt',
    String(params.N),
    String(params.r),
    String(params.p),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

export function parseHash(stored: string): ParsedHash | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (N === undefined || r === undefined || p === undefined) return undefined;
  if (![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0)) return undefined;
  return {
    params: { N, r, p },
    salt: Buffer.from(parts[4] ?? '', 'base64url'),
    key: Buffer.from(parts[5] ?? '', 'base64url'),
  };
}

/** Whether the password matches the stored hash (constant time); false for a malformed hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed?.key.length !== KEY_BYTES) return false;
  const key = await derive(password, parsed.salt, parsed.params);
  return timingSafeEqual(key, parsed.key);
}

/** Whether a stored hash was made with other parameters than the current ones (rehash at login). */
export function needsRehash(stored: string, params: ScryptParams = SCRYPT_PARAMS): boolean {
  const parsed = parseHash(stored);
  return (
    parsed?.params.N !== params.N || parsed.params.r !== params.r || parsed.params.p !== params.p
  );
}
