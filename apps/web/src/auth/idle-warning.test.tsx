import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePageTitle } from '../components/ui/use-page-title.ts';
import { IdleWarning, useLockTitle } from './idle-warning.tsx';

/** UX-1e (#317): the idle warning (G-31) and the re-login cover's title (G-32), restyled. */
describe('IdleWarning', () => {
  it('offers to stay as the primary answer, in a warn callout card with room under the page', () => {
    const onStay = vi.fn();
    const onLogOut = vi.fn();
    const { container } = render(
      <IdleWarning absolute={false} left={95_000} onStay={onStay} onLogOut={onLogOut} />,
    );
    const warning = screen.getByTestId('idle-warning');
    expect(warning.getAttribute('role')).toBe('alert');
    expect(warning.dataset.absolute).toBe('false');
    expect(warning.className).toContain('z-toast');
    expect(warning.className).toContain('md:w-[28rem]');
    // Right of the side nav from xl (232 px); the countdown is not re-announced every second.
    expect(warning.className).toContain('xl:left-62');
    expect(warning.querySelector('.tabular-nums')?.getAttribute('aria-live')).toBe('off');
    // Sans with tabular figures, as every number (2.7, G-15; #393 review F4).
    expect(warning.querySelector('.tabular-nums')?.className.split(' ')).not.toContain('font-mono');
    expect(warning.textContent).toContain('You will be logged out soon');
    expect(warning.textContent).toContain('you will be logged out in 1:35');
    expect(warning.firstElementChild?.className).toContain('bg-warn-soft');
    const stay = within(warning).getByRole('button', { name: 'Stay logged in' });
    expect(stay.dataset.testid).toBe('stay-signed-in');
    expect(stay.className).toContain('bg-accent');
    const out = within(warning).getByRole('button', { name: 'Log out now' });
    expect(out.className).toContain('bg-surface');
    fireEvent.click(stay);
    fireEvent.click(out);
    expect(onStay).toHaveBeenCalledTimes(1);
    expect(onLogOut).toHaveBeenCalledTimes(1);
    // The spacer that keeps the page's end clear of the card.
    const spacer = container.firstElementChild;
    expect(spacer?.getAttribute('aria-hidden')).toBe('true');
    expect(spacer?.className).toContain('h-48');
  });

  it('at the 12-hour limit offers no staying', () => {
    render(
      <IdleWarning absolute left={30_000} onStay={() => undefined} onLogOut={() => undefined} />,
    );
    const warning = screen.getByTestId('idle-warning');
    expect(warning.dataset.absolute).toBe('true');
    expect(warning.textContent).toContain('Your session reaches its 12-hour limit in 0:30');
    expect(screen.queryByTestId('stay-signed-in')).toBeNull();
  });
});

describe('useLockTitle', () => {
  function Cover() {
    useLockTitle();
    return null;
  }
  function Page({ title }: { readonly title: string }) {
    usePageTitle(title);
    return null;
  }

  it('titles the tab while the cover is up, over what the page sets meanwhile, then gives it back', () => {
    const page = render(<Page title="Users" />);
    expect(document.title).toBe('Users · ShopFloor Twin');
    const cover = render(<Cover />);
    expect(document.title).toBe('Log in again · ShopFloor Twin');
    // The kept page finishes loading under the cover: its title waits.
    page.rerender(<Page title="Users (3)" />);
    expect(document.title).toBe('Log in again · ShopFloor Twin');
    cover.unmount();
    expect(document.title).toBe('Users (3) · ShopFloor Twin');
    page.unmount();
  });
});
