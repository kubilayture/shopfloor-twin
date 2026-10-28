/**
 * When the live client starts again after 4403 closes: at most once per interval, so a MES that
 * keeps refusing a session `/session` says may read does not start it in a loop (UX-7 review). A
 * 4403 inside the interval puts one restart off to the interval's end (#387): dropping it left the
 * desk and the terminal "Offline" until some other change of the session. Timed on the monotonic
 * clock (`performance.now()`): a step of the wall clock cannot put a restart off for hours.
 */
export class Restarts {
  readonly #intervalMs: number;
  /** When the client last started again, now or put off. */
  #last = Number.NEGATIVE_INFINITY;
  #later: ReturnType<typeof setTimeout> | undefined;
  /** Moves with every `cancel`: a restart now that waits on the session checks it is still due. */
  #generation = 0;

  constructor(intervalMs: number) {
    this.#intervalMs = intervalMs;
  }

  /**
   * A 4403 close. True if the client may start again now (the caller starts it, once the session
   * is read again and `current(generation)` still holds); otherwise one restart, `later`, is put
   * off to the end of the interval, unless one already is.
   */
  refused(later: () => void): boolean {
    const now = performance.now();
    const due = this.#last + this.#intervalMs;
    if (now >= due) {
      this.cancel();
      this.#last = now;
      return true;
    }
    this.#later ??= setTimeout(() => {
      this.#later = undefined;
      this.#last = performance.now();
      later();
    }, due - now);
    return false;
  }

  /** Whether a restart is put off. */
  get pending(): boolean {
    return this.#later !== undefined;
  }

  /** The current generation, for a restart now to check with `current` before it starts. */
  get generation(): number {
    return this.#generation;
  }

  /** Whether nothing cancelled restarts since `generation` was read. */
  current(generation: number): boolean {
    return generation === this.#generation;
  }

  /**
   * Drops the restart put off, and a restart now still waiting on the session: a logout, a lost
   * session, an unmount, or a start meanwhile.
   */
  cancel(): void {
    clearTimeout(this.#later);
    this.#later = undefined;
    this.#generation += 1;
  }
}
