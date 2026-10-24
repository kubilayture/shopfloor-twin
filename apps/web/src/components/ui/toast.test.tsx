import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_MS, ToastRegion, clearToasts, dismissToast, toast } from './toast.tsx';

/** UX-1e (#317): design system 4.10. */
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  act(() => {
    clearToasts();
  });
  vi.useRealTimers();
});

const region = () => screen.getByTestId('toast-region');
const polite = () => region().querySelector<HTMLElement>('[aria-live="polite"]');
const assertive = () => region().querySelector<HTMLElement>('[aria-live="assertive"]');
/** The visible toast with this title (the live regions hold a hidden copy of the words). */
const card = (title: string) =>
  [...region().querySelectorAll<HTMLElement>('[data-tone]')].find(
    (c) => c.querySelector('p')?.textContent === title,
  ) ?? null;

describe('Toast', () => {
  it('has both live regions from the start, empty, adding no status or alert role to the page', () => {
    render(<ToastRegion />);
    expect(polite()?.childElementCount).toBe(0);
    expect(assertive()?.childElementCount).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(region().className).toContain('pointer-events-none');
    // At the top below md, under the 48 px top bar and off the idle card; bottom right from md.
    expect(region().className).toMatch(/\btop-16\b.*\bmd:top-auto\b.*\bmd:bottom-4\b/);
  });

  it('announces neutral and ok politely, alarms assertively, words only', () => {
    render(<ToastRegion />);
    act(() => {
      toast({
        tone: 'ok',
        title: 'Coding saved',
        body: 'Breakdown on CNC-01, 22:00 to 22:14.',
        action: { label: 'Undo', onClick: () => undefined },
      });
      toast({ tone: 'alarm', title: 'Write refused' });
    });
    expect(card('Coding saved')?.dataset.tone).toBe('ok');
    expect(card('Coding saved')?.textContent).toContain('Breakdown on CNC-01, 22:00 to 22:14.');
    // The live regions read the title and body, never "Dismiss" or the action (#352 review L5).
    expect(polite()?.textContent).toBe('Coding saved. Breakdown on CNC-01, 22:00 to 22:14.');
    expect(polite()?.className).toBe('sr-only');
    expect(assertive()?.textContent).toBe('Write refused');
    expect(card('Coding saved')?.closest('[aria-live]')).toBeNull();
  });

  it('lets a timed toast go after 6 s, and keeps an alarm until dismissed', () => {
    render(<ToastRegion />);
    act(() => {
      toast({ tone: 'neutral', title: 'Filter cleared' });
      toast({ tone: 'alarm', title: 'Write refused' });
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(card('Filter cleared')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(card('Filter cleared')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const alarm = card('Write refused');
    fireEvent.click(within(alarm ?? document.body).getByRole('button', { name: 'Dismiss' }));
    expect(card('Write refused')).toBeNull();
  });

  it('pauses while hovered or focused, and resumes with the time it had left', () => {
    render(<ToastRegion />);
    act(() => {
      toast({ tone: 'ok', title: 'Coding saved' });
    });
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    fireEvent.pointerEnter(region());
    expect(region().dataset.paused).toBe('true');
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(card('Coding saved')).not.toBeNull();
    fireEvent.pointerLeave(region());
    act(() => {
      vi.advanceTimersByTime(1_900);
    });
    expect(card('Coding saved')).not.toBeNull();
    // Focus pauses it too, and only leaving the region resumes it.
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.focus(dismiss);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(card('Coding saved')).not.toBeNull();
    fireEvent.blur(dismiss, { relatedTarget: null });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(card('Coding saved')).toBeNull();
  });

  it('shows at most three, the oldest timed one leaving first, and runs an action once', () => {
    render(<ToastRegion />);
    const undo = vi.fn();
    act(() => {
      toast({ tone: 'alarm', title: 'A' });
      toast({ tone: 'ok', title: 'B' });
      toast({ tone: 'ok', title: 'C', action: { label: 'Undo', onClick: undo } });
      toast({ tone: 'neutral', title: 'D' });
    });
    expect(card('A')).not.toBeNull();
    expect(card('B')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(card('C')).toBeNull();
    act(() => {
      toast({ tone: 'alarm', title: 'E' });
      toast({ tone: 'alarm', title: 'F' });
    });
    expect(card('D')).toBeNull();
    expect(card('A')).not.toBeNull();
    act(() => {
      toast({ tone: 'alarm', title: 'G' });
    });
    // Only alarms over the limit: the oldest of them goes.
    expect(card('A')).toBeNull();
    expect(['E', 'F', 'G'].every((t) => card(t))).toBe(true);
  });

  it('dismisses by id, and ignores an id it does not have', () => {
    render(<ToastRegion />);
    let id = 0;
    act(() => {
      id = toast({ tone: 'neutral', title: 'Exported' });
    });
    act(() => {
      dismissToast(id + 100);
    });
    expect(card('Exported')).not.toBeNull();
    act(() => {
      dismissToast(id);
    });
    expect(card('Exported')).toBeNull();
  });

  it('resumes once the focused toast is dismissed, though its button fired no blur', async () => {
    render(<ToastRegion />);
    act(() => {
      toast({ tone: 'alarm', title: 'Write refused' });
      toast({ tone: 'ok', title: 'Coding saved' });
    });
    const dismiss = within(card('Write refused') ?? document.body).getByRole('button', {
      name: 'Dismiss',
    });
    dismiss.focus();
    fireEvent.focus(dismiss);
    expect(region().dataset.paused).toBe('true');
    // Removed with the focus on it: jsdom, like browsers, may fire no blur.
    fireEvent.click(dismiss);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(region().dataset.paused).toBe('false');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_MS);
    });
    expect(card('Coding saved')).toBeNull();
  });
});
