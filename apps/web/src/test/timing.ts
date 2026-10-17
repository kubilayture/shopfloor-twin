// The web suite's copy of `@shopfloor/test-kit/timing` (#212): the web image installs no
// test-only workspace package. A bound on how long something takes is checked against the bound
// plus the scheduler lag measured while it ran.

/**
 * Runs `work` while sampling the event loop every `sampleMs`: how long it took, and the worst
 * scheduler lag seen meanwhile (how late a timer fired against when it was due).
 */
export async function timed<T>(
  work: () => Promise<T>,
  sampleMs = 10,
): Promise<{ readonly value: T; readonly elapsedMs: number; readonly maxLagMs: number }> {
  let maxLagMs = 0;
  let due = performance.now() + sampleMs;
  const sampler = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - due);
    due = now + sampleMs;
  }, sampleMs);
  const started = performance.now();
  try {
    const value = await work();
    const elapsedMs = performance.now() - started;
    maxLagMs = Math.max(maxLagMs, performance.now() - due);
    return { value, elapsedMs, maxLagMs };
  } finally {
    clearInterval(sampler);
  }
}
