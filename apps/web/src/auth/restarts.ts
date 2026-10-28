/**
 * When the live client starts again after 4403 closes: at most once per interval, so a MES that
 * keeps refusing a session `/session` says may read does not start it in a loop (UX-7 review). A
 * 4403 inside the interval puts one restart off to the interval's end (#387): dropping it left the
 * desk and the terminal "Offline" until some other change of the session.
 */
export class Restarts {
  readonly #intervalMs: number;
  /** When the client last started again, now or put off. */
  #last = Number.NEGATIVE_INFINITY;
  #later: ReturnType<typeof setTimeout> | undefined;

  constructor(intervalMs: number) {
    this.#intervalMs = intervalMs;
  }

  /**
   * A 4403 close. True if the client may start again now (the caller starts it); otherwise one
   * restart, `later`, is put off to the end of the interval, unless one already is.
   */
  refused(later: () => void): boolean {
    const now = Date.now();
    const due = this.#last + this.#intervalMs;
    if (now >= due) {
      this.cancel();
      this.#last = now;
      return true;
    }
    this.#later ??= setTimeout(() => {
      this.#later = undefined;
      this.#last = Date.now();
      later();
    }, due - now);
    return false;
  }

  /** Whether a restart is put off. */
  get pending(): boolean {
    return this.#later !== undefined;
  }

  /** Drops the restart put off: a logout, a lost session, an unmount, or a start meanwhile. */
  cancel(): void {
    clearTimeout(this.#later);
    this.#later = undefined;
  }
}
