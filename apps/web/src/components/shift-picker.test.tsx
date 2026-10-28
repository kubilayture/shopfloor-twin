import { cleanup, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShiftSpan, shiftKeyLabel, shiftLabel } from './shift-picker.tsx';

describe('shift span and shift words (moved from the OEE dashboard, UX-4b)', () => {
  it('writes a one-day shift span with the date once, and a shift outside the list in words', () => {
    render(<ShiftSpan start="2026-10-12T03:00:00.000Z" end="2026-10-12T11:00:00.000Z" />);
    expect(document.body.textContent).toBe('Mon 12 Oct, 06:00 – 14:00');
    cleanup();
    render(<ShiftSpan start="2026-10-12T19:00:00.000Z" end="2026-10-13T03:00:00.000Z" />);
    expect(document.body.textContent).toBe('Mon 12 Oct, 22:00 – Tue 13 Oct, 06:00');
    expect(shiftKeyLabel('2020-01-06/A')).toBe('Mon 06 Jan, shift A');
    expect(shiftKeyLabel('not-a-key')).toBe('not-a-key');
  });

  it('writes the day as the span does, two digits (#368 review)', () => {
    const shift = {
      key: '2026-01-05/C',
      date: '2026-01-05',
      shift: 'C',
      start: '2026-01-05T19:00:00.000Z',
      end: '2026-01-06T03:00:00.000Z',
      breaks: [],
    };
    expect(shiftLabel(shift)).toBe('Mon 05 Jan, shift C (22:00–06:00)');
    render(<ShiftSpan start={shift.start} end={shift.end} />);
    expect(document.body.textContent).toBe('Mon 05 Jan, 22:00 – Tue 06 Jan, 06:00');
    cleanup();
  });
});
