import { act } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * Lets the overlay events the stand-ins of `setup.ts` queue (`close`, `toggle`) arrive, as the
 * browser delivers them in a later task, and React handle what they set. Works with real and with
 * fake timers.
 */
export async function flushOverlayEvents(): Promise<void> {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
