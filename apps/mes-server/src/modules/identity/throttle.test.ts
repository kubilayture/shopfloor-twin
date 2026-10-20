import { describe, expect, it } from 'vitest';
import { BUSY, BoundedSemaphore, LoginThrottle } from './throttle.ts';

const WINDOW = 15 * 60_000;
const make = () =>
  new LoginThrottle({ reservations: 2, reservationQueue: 2, perNameQueue: 3, exemptMs: WINDOW });

describe('login throttle memory (#264 review, F1)', () => {
  it('answers a known wait rounded up, and forgets it after a success', () => {
    const throttle = make();
    expect(throttle.refusal('ana', '10.0.0.1', 0)).toBeUndefined();
    throttle.noteGlobal('ana', 30_000);
    expect(throttle.refusal('ana', '10.0.0.1', 0)).toBe(30);
    expect(throttle.refusal('ana', '10.0.0.1', 10_500)).toBe(20);
    expect(throttle.refusal('ana', '10.0.0.1', 30_000)).toBeUndefined();
    throttle.noteGlobal('ana', 60_000);
    throttle.noteSuccess('ana', '10.0.0.2', 40_000);
    expect(throttle.refusal('ana', '10.0.0.1', 40_001)).toBeUndefined();
  });

  it('exempts an address with a success within the window from the global delay, not from an admin delay (F3)', () => {
    const throttle = make();
    throttle.noteSuccess('bo', '10.0.0.9', 0);
    throttle.noteGlobal('bo', 30_000);
    expect(throttle.refusal('bo', '10.0.0.9', 1_000)).toBeUndefined();
    expect(throttle.refusal('bo', '10.0.0.8', 1_000)).toBe(29);
    throttle.noteGlobal('bo', WINDOW + 30_000);
    expect(throttle.refusal('bo', '10.0.0.9', WINDOW)).toBe(30);
    throttle.noteAdmin('bo', WINDOW + 60_000);
    throttle.noteSuccess('bo', '10.0.0.7', WINDOW);
    throttle.noteAdmin('bo', WINDOW + 5_000);
    expect(throttle.refusal('bo', '10.0.0.7', WINDOW)).toBe(5);
    throttle.prune(10 * WINDOW);
    expect(throttle.refusal('bo', '10.0.0.7', 10 * WINDOW)).toBeUndefined();
  });

  it('decides one name at a time and refuses beyond its queue', async () => {
    const throttle = make();
    const order: number[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = throttle.serial('cy', async () => {
      await gate;
      order.push(1);
    });
    const second = throttle.serial('cy', () => {
      order.push(2);
      return Promise.resolve();
    });
    const third = throttle.serial('cy', () => Promise.resolve(order.push(3)));
    expect(await throttle.serial('cy', () => Promise.resolve(4))).toBe(BUSY);
    // Another name is not held up.
    expect(await throttle.serial('dee', () => Promise.resolve('other'))).toBe('other');
    release();
    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('bounds reservations at once and their queue', async () => {
    const semaphore = new BoundedSemaphore(1, 1);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const running = semaphore.run(() => gate);
    const waiting = semaphore.run(() => Promise.resolve('queued'));
    expect(await semaphore.run(() => Promise.resolve('over'))).toBe(BUSY);
    expect(semaphore.active).toBe(1);
    release();
    await running;
    expect(await waiting).toBe('queued');
  });
});
