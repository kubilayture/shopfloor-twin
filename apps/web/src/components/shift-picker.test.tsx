import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, problem } from '../test/fixtures.ts';
import { CURRENT_SHIFT } from '../test/oee-fixtures.ts';
import {
  ShiftPicker,
  ShiftSpan,
  shiftKeyLabel,
  shiftLabel,
  useShiftSelection,
} from './shift-picker.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useShiftSelection: what the screen’s error reads of it (#394)', () => {
  it('takes the list’s answer and failure into its answer time, not only the current shift’s', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
        .pathname;
      if (path === '/api/v1/shifts/current') return json(CURRENT_SHIFT);
      // The list fails, and later than the current shift answered.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return problem(503, 'Service Unavailable', 'shifts not ready', path);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useShiftSelection(undefined), { wrapper });
    await waitFor(() => {
      expect(result.current.error).toBeTruthy();
    });
    const current = client.getQueryState(['shifts', 'current']);
    const list = client
      .getQueryCache()
      .findAll({ queryKey: ['shifts', 'list'] })
      .map((query) => query.state)
      .find((state) => state.status === 'error');
    expect(list?.errorUpdatedAt).toBeGreaterThan(current?.dataUpdatedAt ?? Infinity);
    expect(result.current.answeredAt).toBe(list?.errorUpdatedAt);
    expect(result.current.failedAt).toBe(list?.errorUpdatedAt);
  });
});

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

  it('keeps the whole option at 390 px: its label goes above the select below sm (#339)', () => {
    const shift = {
      key: '2026-10-14/B',
      date: '2026-10-14',
      shift: 'B',
      start: '2026-10-14T11:00:00.000Z',
      end: '2026-10-14T19:00:00.000Z',
      breaks: [],
    };
    render(
      <ShiftPicker
        selection={{
          current: { clock: null, shiftKey: shift.key, shift },
          shifts: [shift],
          selected: shift.key,
          isCurrent: true,
          pending: false,
          error: null,
          retrying: false,
          failedAt: 0,
          answeredAt: 0,
          retry: () => undefined,
        }}
        onChange={() => undefined}
      />,
    );
    const select = screen.getByRole('combobox', { name: 'Shift' });
    expect(select.getAttribute('data-testid')).toBe('shift-select');
    expect(select.closest('.sm\\:flex-row')).not.toBeNull();
    expect(select.closest('.flex-col')).not.toBeNull();
    expect(within(select).getAllByRole('option')[0]?.textContent).toBe(
      'Wed 14 Oct, shift B (14:00–22:00) – current',
    );
    cleanup();
  });
});
