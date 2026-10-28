import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Restarts } from './restarts.ts';

const INTERVAL = 30_000;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A 4403 close as `AuthProvider` handles it: starts now when allowed, and records each start. */
function closes(restarts: Restarts, starts: number[]) {
  const start = () => starts.push(Date.now());
  return () => {
    if (restarts.refused(start)) start();
  };
}

describe('Restarts after 4403 closes (#387)', () => {
  it('starts once now and once at the end of the interval for two closes 1 s apart', () => {
    const restarts = new Restarts(INTERVAL);
    const starts: number[] = [];
    const close = closes(restarts, starts);
    const t0 = Date.now();
    close();
    expect(starts).toEqual([t0]);
    vi.advanceTimersByTime(1_000);
    close();
    expect(starts).toEqual([t0]);
    expect(restarts.pending).toBe(true);
    vi.advanceTimersByTime(INTERVAL - 1_000 - 1);
    expect(starts).toEqual([t0]);
    vi.advanceTimersByTime(1);
    expect(starts).toEqual([t0, t0 + INTERVAL]);
    expect(restarts.pending).toBe(false);
    // Nothing more comes on its own.
    vi.advanceTimersByTime(10 * INTERVAL);
    expect(starts).toHaveLength(2);
  });

  it('never starts more than once per interval under a stream of closes, nor stops starting', () => {
    const restarts = new Restarts(INTERVAL);
    const starts: number[] = [];
    const close = closes(restarts, starts);
    // A close every 700 ms for five minutes, as a MES refusing every connection would send them.
    for (let elapsed = 0; elapsed < 300_000; elapsed += 700) {
      close();
      vi.advanceTimersByTime(700);
    }
    vi.advanceTimersByTime(INTERVAL);
    const gaps = starts.slice(1).map((at, i) => at - (starts[i] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(INTERVAL);
    // One start per interval: none dropped (the first now, then one at each interval's end).
    expect(starts).toHaveLength(11);
    expect(gaps.every((gap) => gap === INTERVAL)).toBe(true);
  });

  it('puts off one restart however many closes come inside the interval', () => {
    const restarts = new Restarts(INTERVAL);
    const later = vi.fn();
    expect(restarts.refused(later)).toBe(true);
    expect(restarts.refused(later)).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(restarts.refused(later)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(INTERVAL);
    expect(later).toHaveBeenCalledOnce();
  });

  it('counts the interval from the restart put off, not from the close that put it off', () => {
    const restarts = new Restarts(INTERVAL);
    const later = vi.fn();
    restarts.refused(later);
    vi.advanceTimersByTime(29_000);
    restarts.refused(later);
    vi.advanceTimersByTime(1_000);
    expect(later).toHaveBeenCalledOnce();
    // 1 s after that restart: put off again, to 30 s after it.
    vi.advanceTimersByTime(1_000);
    expect(restarts.refused(later)).toBe(false);
    vi.advanceTimersByTime(INTERVAL - 1_000 - 1);
    expect(later).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(later).toHaveBeenCalledTimes(2);
  });

  it('drops the restart put off on cancel, and a close after the interval starts at once', () => {
    const restarts = new Restarts(INTERVAL);
    const later = vi.fn();
    restarts.refused(later);
    restarts.refused(later);
    restarts.cancel();
    expect(restarts.pending).toBe(false);
    vi.advanceTimersByTime(10 * INTERVAL);
    expect(later).not.toHaveBeenCalled();
    expect(restarts.refused(later)).toBe(true);
  });

  it('drops the restart put off when a close past the interval starts it now', () => {
    const restarts = new Restarts(INTERVAL);
    const later = vi.fn();
    restarts.refused(later);
    restarts.refused(later);
    // The timer is late (a busy tab): a close at the interval's end starts the client itself.
    vi.setSystemTime(Date.now() + INTERVAL);
    expect(restarts.refused(later)).toBe(true);
    expect(restarts.pending).toBe(false);
    vi.advanceTimersByTime(INTERVAL);
    expect(later).not.toHaveBeenCalled();
  });
});
