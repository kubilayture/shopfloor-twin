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

  /**
   * Whether `address` logged in as `name` within the window (#264 round 3, R1): such an attempt
   * spends no token of the shared ceiling for all logins.
   */
  recentSuccess(name: string, address: string, now: number): boolean {
    const state = this.#names.get(name);
    return state !== undefined && this.#exempt(state, address, now);
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

/**
 * Slots for the password hashes of logins (#264 re-review, N1): every admitted attempt costs one
 * scrypt hash (a dummy one for an unknown name), and the hashes run two at a time, about 14 per
 * second. Without a bound their queue grew under attack until every login, the victim's included,
 * waited longer than nginx's timeout. At most `total` attempts hold a slot (running or waiting
 * for a hash), at most `perAddress` of them from one client address, so no address takes the
 * slots of the others; an attempt that finds none is answered 429 without a hash.
 */
export class HashSlots {
  readonly #total: number;
  readonly #perAddress: number;
  #held = 0;
  readonly #byAddress = new Map<string, number>();

  constructor(total: number, perAddress: number) {
    this.#total = total;
    this.#perAddress = perAddress;
  }

  get held(): number {
    return this.#held;
  }

  /** A slot for `address`, released by the function returned; undefined when none is free. */
  take(address: string): (() => void) | undefined {
    const mine = this.#byAddress.get(address) ?? 0;
    if (this.#held >= this.#total || mine >= this.#perAddress) return undefined;
    this.#held++;
    this.#byAddress.set(address, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held--;
      const left = (this.#byAddress.get(address) ?? 1) - 1;
      if (left === 0) this.#byAddress.delete(address);
      else this.#byAddress.set(address, left);
    };
  }
}
