import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.ts';
import { SimError } from '../../api/sim.ts';
import { flushOverlayEvents } from '../../test/overlay.ts';
import { QueryError } from '../query-error.tsx';
import { Disclosure } from './disclosure.tsx';
import { EmptyState } from './empty-state.tsx';
import { ErrorState, isNetworkError, isRetryable } from './error-state.tsx';
import { SectionNav } from './section-nav.tsx';
import { SKELETON_DELAY_MS, Skeleton } from './skeleton.tsx';
import { InfoTip, TOOLTIP_DELAY_MS, Tooltip } from './tooltip.tsx';

/** UX-1e (#317): design system 4.11, 4.12 and 3.4. */
afterEach(() => {
  vi.useRealTimers();
});

describe('EmptyState', () => {
  it('says what is empty, why, and offers the action, under the test id of the old text', () => {
    render(
      <EmptyState
        title="No holds match these filters"
        body="Clear a filter to see more holds."
        action={<button type="button">Clear filters</button>}
        icon="filter"
        testId="hold-list-empty"
      />,
    );
    const empty = screen.getByTestId('hold-list-empty');
    expect(empty.dataset.empty).toBe('section');
    expect(empty.className).toMatch(/\bitems-center\b/);
    expect(within(empty).getByText('No holds match these filters').tagName).toBe('P');
    expect(within(empty).getByText('Clear a filter to see more holds.')).toBeTruthy();
    expect(within(empty).getByRole('button', { name: 'Clear filters' })).toBeTruthy();
    expect(empty.querySelector('svg[data-icon="filter"]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(empty.hasAttribute('role')).toBe(false);
  });

  it('is an h2 block on a page, a line inline', () => {
    const { rerender } = render(<EmptyState size="page" title="No order PO-NOPE" testId="e" />);
    expect(screen.getByRole('heading', { level: 2, name: 'No order PO-NOPE' })).toBeTruthy();
    rerender(<EmptyState size="inline" title="No plant events yet" icon="clock" testId="e" />);
    const empty = screen.getByTestId('e');
    expect(empty.dataset.empty).toBe('inline');
    expect(empty.className).toMatch(/\btext-left\b/);
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

describe('Skeleton', () => {
  it('is a status with the loading text at once, and shows its shapes only after 300 ms', () => {
    vi.useFakeTimers();
    render(<Skeleton shape="table" label="Loading OEE…" testId="oee-loading" />);
    const skeleton = screen.getByRole('status');
    expect(skeleton.dataset.testid).toBe('oee-loading');
    expect(screen.getByText('Loading OEE…').className).toBe('sr-only');
    const shapes = skeleton.querySelector('[aria-hidden="true"]');
    // The frame holds its size from the start, invisible until the delay is over.
    expect(shapes?.className).toBe('invisible');
    // A header and five rows.
    expect(shapes?.querySelectorAll('.h-10')).toHaveLength(5);
    expect(shapes?.querySelectorAll('.h-9')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS - 1);
    });
    expect(skeleton.dataset.shown).toBe('false');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(skeleton.dataset.shown).toBe('true');
    // Shimmer only without reduced motion.
    expect(shapes?.className).toBe('motion-safe:animate-pulse');
  });

  it('draws each shape at its final size, rows as asked', () => {
    const { rerender, container } = render(
      <Skeleton shape="text" rows={4} label="Loading…" delayMs={0} />,
    );
    const blocks = () => container.querySelectorAll('[aria-hidden="true"] .bg-line-subtle');
    expect(blocks()).toHaveLength(4);
    expect(blocks()[3]?.className).toContain('w-3/5');
    rerender(<Skeleton shape="text" label="Loading…" delayMs={0} />);
    expect(blocks()).toHaveLength(3);
    rerender(<Skeleton shape="stat" label="Loading…" delayMs={0} />);
    expect(container.querySelector('.h-8')).not.toBeNull();
    rerender(<Skeleton shape="chart" label="Loading…" delayMs={0} />);
    expect(container.querySelector('.h-64')).not.toBeNull();
    rerender(<Skeleton shape="card" label="Loading…" delayMs={0} />);
    expect(container.querySelector('.rounded-lg.border')).not.toBeNull();
    rerender(<Skeleton shape="table" rows={2} label="Loading…" delayMs={0} />);
    expect(container.querySelectorAll('.h-10')).toHaveLength(2);
    expect(screen.getByRole('status').dataset.shown).toBe('true');
  });
});

describe('ErrorState', () => {
  const unavailable = new ApiError('Service Unavailable: database down', 503);

  it('says what could not be loaded, the detail, and offers "Try again" for a 5xx', () => {
    const retry = vi.fn();
    render(
      <ErrorState what="the active alarms" error={unavailable} onRetry={retry} testId="err" />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.dataset.testid).toBe('err');
    expect(alert.className).toContain('bg-alarm-soft');
    expect(alert.textContent).toContain('Could not load the active alarms.');
    expect(within(alert).getByText('Service Unavailable: database down').className).toContain(
      'text-ink-secondary',
    );
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('offers no "Try again" for a refused request or an unreadable answer', () => {
    const { rerender } = render(
      <ErrorState
        what="machine nope"
        error={new ApiError('Not Found: unknown', 404)}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Could not load machine nope.');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    rerender(<ErrorState what="x" error={unavailable} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    rerender(<ErrorState what="x" error="what" onRetry={() => undefined} />);
    expect(screen.getByRole('alert').textContent).toContain('Unknown error');
  });

  it('knows which errors a retry can fix', () => {
    expect(isRetryable(new ApiError('The MES cannot be reached', 0))).toBe(true);
    expect(isRetryable(new ApiError('Too Many Requests', 429))).toBe(true);
    expect(isRetryable(new ApiError('Bad Gateway', 502))).toBe(true);
    expect(isRetryable(new ApiError('Internal', 500))).toBe(true);
    expect(isRetryable(new SimError('The console cannot be reached', 0))).toBe(true);
    expect(isRetryable(new ApiError('Not Found', 404))).toBe(false);
    expect(isRetryable(new ApiError('Bad Request', 400))).toBe(false);
    expect(isRetryable(new ApiError('Unexpected answer', 200))).toBe(false);
    expect(isRetryable(new ApiError('Conflict', 499))).toBe(false);
    expect(isRetryable(new SimError('Forbidden', 403))).toBe(false);
    expect(isRetryable(new Error('no status'))).toBe(true);
    expect(isRetryable(Object.assign(new Error('odd'), { status: '503' }))).toBe(true);
    expect(isNetworkError(new ApiError('The MES cannot be reached', 0))).toBe(true);
    // The proxy could not reach the MES: as unreachable as no answer.
    expect(isNetworkError(new ApiError('HTTP 502', 502))).toBe(true);
    expect(isNetworkError(new ApiError('HTTP 504', 504))).toBe(true);
    expect(isNetworkError(new ApiError('Service Unavailable: database down', 503))).toBe(false);
    expect(isNetworkError(new ApiError('Not Found', 404))).toBe(false);
    expect(isNetworkError(new Error('no status'))).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });

  it('is one quiet line, not announced and without a retry, when asked to be', () => {
    render(
      <ErrorState
        what="the active alarms"
        error={new ApiError('The MES cannot be reached', 0)}
        onRetry={() => undefined}
        quiet
        testId="err"
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    const line = screen.getByTestId('err');
    expect(line.dataset.error).toBe('quiet');
    expect(line.textContent).toBe('Could not load the active alarms. The MES cannot be reached');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('QueryError keeps its props and stays an alert outside the live connection', () => {
    render(
      <QueryError
        what="the run"
        error={new ApiError('The MES cannot be reached', 0)}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Could not load the run.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('Disclosure', () => {
  it('is a details element, closed unless asked, with a turning chevron', () => {
    const { rerender } = render(
      <Disclosure summary="What the status means" testId="status-help">
        <p>Running: making parts.</p>
      </Disclosure>,
    );
    const details = screen.getByTestId<HTMLDetailsElement>('status-help');
    expect(details.tagName).toBe('DETAILS');
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary');
    expect(summary?.textContent).toBe('What the status means');
    expect(summary?.className).toMatch(/\bmin-h-6\b/);
    expect(summary?.querySelector('svg')?.getAttribute('class')).toContain('group-open:rotate-90');
    rerender(
      <Disclosure summary="Payload" defaultOpen testId="status-help">
        <p>{'{}'}</p>
      </Disclosure>,
    );
    expect(screen.getByTestId<HTMLDetailsElement>('status-help').open).toBe(true);
  });
});

describe('SectionNav', () => {
  it('is a named navigation landmark of anchor links to the sections', () => {
    render(
      <SectionNav
        items={[
          { id: 'order-header', label: 'Header' },
          { id: 'order-bom', label: 'Bill of materials' },
        ]}
        testId="order-sections"
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    expect(nav.dataset.testid).toBe('order-sections');
    expect(nav.className).toContain('xl:sticky');
    expect(within(nav).getByRole('link', { name: 'Bill of materials' }).getAttribute('href')).toBe(
      '#order-bom',
    );
  });
});

describe('Tooltip', () => {
  function Tip() {
    return (
      <Tooltip content="0.8125 exactly: 13/16">
        <button type="button" aria-describedby="other">
          81.3 %
        </button>
      </Tooltip>
    );
  }
  const tip = () => screen.getByRole('tooltip');

  it('describes its trigger and shows on hover after 400 ms, hides on leave', () => {
    vi.useFakeTimers();
    render(<Tip />);
    const trigger = screen.getByRole('button', { name: '81.3 %' });
    const anchor = trigger.parentElement ?? trigger;
    expect(trigger.getAttribute('aria-describedby')).toBe(`other ${tip().id}`);
    expect(tip().getAttribute('popover')).toBe('manual');
    fireEvent.pointerEnter(anchor);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);
    });
    expect(tip().hasAttribute('data-popover-open')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(tip().hasAttribute('data-popover-open')).toBe(true);
    expect(tip().textContent).toBe('0.8125 exactly: 13/16');
    // Hoverable: moving onto the tooltip keeps it.
    fireEvent.pointerLeave(anchor);
    fireEvent.pointerEnter(tip());
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(tip().hasAttribute('data-popover-open')).toBe(true);
    fireEvent.pointerLeave(tip());
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(tip().hasAttribute('data-popover-open')).toBe(false);
  });

  it('shows on keyboard focus, hides on Escape and on blur', () => {
    vi.useFakeTimers();
    render(<Tip />);
    const trigger = screen.getByRole('button', { name: '81.3 %' });
    fireEvent.focus(trigger);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(tip().dataset.open).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tip().dataset.open).toBe('false');
    expect(tip().hasAttribute('data-popover-open')).toBe(false);
    fireEvent.focus(trigger);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(tip().dataset.open).toBe('true');
    fireEvent.blur(trigger);
    expect(tip().dataset.open).toBe('false');
    // A focus that leaves before the delay shows nothing.
    fireEvent.focus(trigger);
    fireEvent.blur(trigger);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(tip().dataset.open).toBe('false');
  });
});

describe('InfoTip', () => {
  it('is a named button that toggles its explanation and says whether it is open', async () => {
    render(
      <InfoTip label="About line OEE">
        <p>Line OEE is taken at the bottleneck.</p>
      </InfoTip>,
    );
    const button = screen.getByRole('button', { name: 'About line OEE' });
    const panel = screen.getByRole('note');
    expect(panel.getAttribute('aria-label')).toBe('About line OEE');
    expect(button.getAttribute('aria-controls')).toBe(panel.id);
    expect(button.getAttribute('popovertarget')).toBe(panel.id);
    expect(panel.getAttribute('popover')).toBe('auto');
    expect(panel.className).toContain('[&:not([data-placed])]:invisible');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(panel.hasAttribute('data-popover-open')).toBe(true);
    // Hidden until its toggle event, a task later, has placed it.
    expect(panel.hasAttribute('data-placed')).toBe(false);
    await flushOverlayEvents();
    expect(panel.hasAttribute('data-placed')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(panel.hasAttribute('data-popover-open')).toBe(false);
    await flushOverlayEvents();
    expect(panel.hasAttribute('data-placed')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('without the Popover API (#352 L2)', () => {
  function withoutPopover(run: () => void) {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const saved = proto.showPopover;
    delete proto.showPopover;
    try {
      run();
    } finally {
      proto.showPopover = saved;
    }
  }

  it('renders no tooltip, only the trigger, and the InfoTip as a details in place', () => {
    withoutPopover(() => {
      render(
        <>
          <Tooltip content="13/16 exactly">
            <button type="button">81.3 %</button>
          </Tooltip>
          <InfoTip label="About line OEE">
            <p>Line OEE is taken at the bottleneck.</p>
          </InfoTip>
        </>,
      );
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(screen.getByRole('button', { name: '81.3 %' }).hasAttribute('aria-describedby')).toBe(
        false,
      );
      expect(document.querySelector('[popover]')).toBeNull();
      const details = document.querySelector('details');
      expect(details?.querySelector('summary')?.getAttribute('aria-label')).toBe('About line OEE');
      expect(details?.textContent).toContain('Line OEE is taken at the bottleneck.');
    });
  });
});
