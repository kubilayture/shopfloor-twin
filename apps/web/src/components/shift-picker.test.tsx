import { cleanup, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShiftSpan, shiftKeyLabel } from './shift-picker.tsx';

describe('shift span and shift words (moved from the OEE dashboard, UX-4b)', () => {
  it('writes a one-day shift span with the date once, and a shift outside the list in words', () => {
    render(<ShiftSpan start="2026-10-12T03:00:00.000Z" end="2026-10-12T11:00:00.000Z" />);
    expect(document.body.textContent).toBe('Mon 12 Oct, 06:00 – 14:00');
    cleanup();
    render(<ShiftSpan start="2026-10-12T19:00:00.000Z" end="2026-10-13T03:00:00.000Z" />);
    expect(document.body.textContent).toBe('Mon 12 Oct, 22:00 – Tue 13 Oct, 06:00');
    expect(shiftKeyLabel('2020-01-06/A')).toBe('Mon 6 Jan, shift A');
    expect(shiftKeyLabel('not-a-key')).toBe('not-a-key');
  });
});
