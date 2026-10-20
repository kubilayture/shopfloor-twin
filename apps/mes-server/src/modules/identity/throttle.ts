/**
 * The in-memory side of login throttling (#242, PR #264 security review F1): what the last
 * database decision of each user name said, so that attempts inside a known wait are answered 429
 * without a trip to the database, one decision per name at a time, and a bounded number of
 * reservations at once on the login pool. The database (ADR-0026's reserve-before-hash
 * transaction) stays the authority: after a restart this memory is empty and every attempt is
 * decided there again.
 */

/** A task refused because its queue is full: the caller answers 429. */
export const BUSY = Symbol('busy');

/** At most `limit` tasks at once, at most `queue` waiting; past that, `BUSY` at once. */
export class BoundedSemaphore {
  readonly #limit: number;
  readonly #queue: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number, queue: number) {
    this.#limit = limit;
    this.#queue = queue;
  }

  get active(): number {
    return this.#active;
  }

  async run<T>(task: () => Promise<T>): Promise<T | typeof BUSY> {
    if (this.#active >= this.#limit) {
      if (this.#waiting.length >= this.#queue) return BUSY;
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

interface NameState {
  /** The global delay's end (epoch ms), for every address not exempt. */
  globalUntil: number;
  /** An admin's own delay's end (epoch ms), for every address. */
  adminUntil: number;
  /** Addresses with a success for this name, and when (epoch ms). */
  readonly successes: Map<string, number>;
}

export interface LoginThrottleOptions {
  /** Reservations at once: the login pool's size. */
  readonly reservations: number;
  /** Reservations waiting for a connection, at most. */
  readonly reservationQueue: number;
  /** Attempts on one name waiting for its decision, at most. */
  readonly perNameQueue: number;
  /** How long a success exempts its address from the global delay (the window). */
  readonly exemptMs: number;
}

export class LoginThrottle {
  readonly #options: LoginThrottleOptions;
  readonly #reservations: BoundedSemaphore;
  readonly #names = new Map<string, NameState>();
  /** Per name: the tail of its chain of decisions and how many wait on it. */
  readonly #chains = new Map<string, { tail: Promise<void>; waiting: number }>();

  constructor(options: LoginThrottleOptions) {
    this.#options = options;
    this.#reservations = new BoundedSemaphore(options.reservations, options.reservationQueue);
  }

  /** Runs `task` after every earlier one of this name (decisions one at a time per name). */
  async serial<T>(name: string, task: () => Promise<T>): Promise<T | typeof BUSY> {
    let chain = this.#chains.get(name);
    if (chain !== undefined && chain.waiting >= this.#options.perNameQueue) return BUSY;
    chain ??= { tail: Promise.resolve(), waiting: 0 };
    this.#chains.set(name, chain);
    chain.waiting++;
    const before = chain.tail;
    let done: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => (done = resolve));
    chain.tail = before.then(() => mine);
    await before;
    try {
      return await task();
    } finally {
      chain.waiting--;
      done();
      if (chain.waiting === 0 && this.#chains.get(name) === chain) this.#chains.delete(name);
    }
  }

  /** Runs a reservation within the login pool's bound, or `BUSY`. */
  reservation<T>(task: () => Promise<T>): Promise<T | typeof BUSY> {
    return this.#reservations.run(task);
  }

  /** Whether `address` had a success for `name` within the window. */
  #exempt(state: NameState, address: string, now: number): boolean {
    const at = state.successes.get(address);
    return at !== undefined && now - at < this.#options.exemptMs;
  }

  /** Seconds to wait as the last decisions say, or undefined: ask the database. */
  refusal(name: string, address: string, now: number): number | undefined {
    const state = this.#names.get(name);
    if (state === undefined) return undefined;
    const until = Math.max(
      state.adminUntil,
      this.#exempt(state, address, now) ? 0 : state.globalUntil,
    );
    return until > now ? Math.max(1, Math.ceil((until - now) / 1000)) : undefined;
  }

  #state(name: string): NameState {
    let state = this.#names.get(name);
    if (state === undefined) {
      state = { globalUntil: 0, adminUntil: 0, successes: new Map() };
      this.#names.set(name, state);
    }
    return state;
  }

  /** The database set or found the global delay ending at `until`. */
  noteGlobal(name: string, until: number): void {
    this.#state(name).globalUntil = until;
  }

  /** The database set or found an admin's delay ending at `until`. */
  noteAdmin(name: string, until: number): void {
    this.#state(name).adminUntil = until;
  }

  /** A success from `address`: no wait any more, and the address exempt for the window. */
  noteSuccess(name: string, address: string, now: number): void {
    const state = this.#state(name);
    state.globalUntil = 0;
    state.adminUntil = 0;
    for (const [other, at] of state.successes) {
      if (now - at >= this.#options.exemptMs) state.successes.delete(other);
    }
    state.successes.set(address, now);
  }

  /** An admin's reset, the bootstrap: forget the name. */
  forget(name: string): void {
    this.#names.delete(name);
  }

  /** Forgets names with nothing left to remember (the sweep). */
  prune(now: number): void {
    for (const [name, state] of this.#names) {
      for (const [address, at] of state.successes) {
        if (now - at >= this.#options.exemptMs) state.successes.delete(address);
      }
      if (state.globalUntil <= now && state.adminUntil <= now && state.successes.size === 0) {
        this.#names.delete(name);
      }
    }
  }
}
