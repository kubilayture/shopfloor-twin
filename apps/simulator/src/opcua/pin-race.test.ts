import { describe, expect, it } from 'vitest';
import { checkPinRace } from './pin-race.ts';

// The race of #265 shows on Linux only (inotify); the stack smoke runs the full check in the
// simulator image. Here it runs shorter on any platform, so the check itself stays tested.
describe('the pki step rerun under running certificate managers (#265)', () => {
  it('keeps every pin trusted over unchanged reruns and renewals', async () => {
    const result = await checkPinRace({ reruns: 3, renewals: 3, delaysMs: [0, 20], settleMs: 300 });
    expect(result.runs).toBe(7);
    expect(result.lost).toEqual([]);
  }, 60_000);
});
