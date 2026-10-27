import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { flushOverlayEvents } from '../../test/overlay.ts';
import { Menu, type MenuItem } from './menu.tsx';

/** UX-1e (#317): the menu-button pattern of design system 4.13, over the Popover stand-ins. */

function setup(extra: Partial<MenuItem>[] = []) {
  const chosen = vi.fn<(id: string) => void>();
  const items: MenuItem[] = [
    {
      id: 'print',
      label: 'Print',
      onSelect: () => {
        chosen('print');
      },
    },
    {
      id: 'export',
      label: 'Export CSV',
      onSelect: () => {
        chosen('export');
      },
    },
    {
      id: 'edit',
      label: 'Edit',
      onSelect: () => {
        chosen('edit');
      },
      disabled: true,
    },
    {
      id: 'close',
      label: 'Close order',
      onSelect: () => {
        chosen('close');
      },
      tone: 'danger',
      testId: 'order-close',
    },
    ...extra.map((e, i) => ({ id: `x${String(i)}`, label: 'X', onSelect: () => undefined, ...e })),
  ];
  render(
    <>
      <Menu label="More actions" items={items} align="end" testId="more" />
      <button type="button">After</button>
    </>,
  );
  const trigger = screen.getByRole('button', { name: 'More actions' });
  // A closed popover is hidden, so its accessible name is empty: found by role, named by label.
  const menu = screen.getByRole('menu');
  expect(menu.getAttribute('aria-label')).toBe('More actions');
  const item = (name: string) => screen.getByRole('menuitem', { name });
  const isOpen = () => menu.hasAttribute('data-popover-open');
  return { chosen, trigger, menu, item, isOpen };
}

describe('Menu', () => {
  it('is a menu button: haspopup, expanded state and the menu it controls', async () => {
    const { trigger, menu, item, isOpen } = setup();
    expect(trigger.dataset.testid).toBe('more');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(menu.getAttribute('popover')).toBe('auto');
    expect(screen.getAllByRole('menuitem').map((m) => m.tabIndex)).toEqual([-1, -1, -1, -1]);
    expect(item('Close order').dataset.testid).toBe('order-close');
    expect(item('Close order').className).toContain('text-alarm-ink');
    expect(item('Edit').getAttribute('aria-disabled')).toBe('true');
    expect(menu.className).toContain('[&:not([data-placed])]:invisible');
    fireEvent.click(trigger);
    // Open at once, but hidden until its toggle event has placed it.
    expect(isOpen()).toBe(true);
    expect(menu.hasAttribute('data-placed')).toBe(false);
    await flushOverlayEvents();
    expect(menu.hasAttribute('data-placed')).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(item('Print'));
  });

  it('moves with the arrows (wrapping), Home and End, and by first letter', async () => {
    const { trigger, menu, item } = setup();
    fireEvent.click(trigger);
    await flushOverlayEvents();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Export CSV'));
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(item('Close order'));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Print'));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(item('Close order'));
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(item('Print'));
    fireEvent.keyDown(menu, { key: 'e' });
    expect(document.activeElement).toBe(item('Export CSV'));
    fireEvent.keyDown(menu, { key: 'E' });
    expect(document.activeElement).toBe(item('Edit'));
    fireEvent.keyDown(menu, { key: 'c' });
    expect(document.activeElement).toBe(item('Close order'));
    // No item starts with it: the focus stays; a modified key is not type-ahead.
    fireEvent.keyDown(menu, { key: 'z' });
    expect(document.activeElement).toBe(item('Close order'));
    fireEvent.keyDown(menu, { key: 'p', ctrlKey: true });
    expect(document.activeElement).toBe(item('Close order'));
  });

  it('opens from the keyboard on the first item (ArrowDown) or the last (ArrowUp)', async () => {
    const { trigger, menu, item, isOpen } = setup();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    await flushOverlayEvents();
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(item('Close order'));
    fireEvent.keyDown(menu, { key: 'Escape' });
    await flushOverlayEvents();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await flushOverlayEvents();
    expect(document.activeElement).toBe(item('Print'));
    // Open already: the arrows on the button move into it.
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    await flushOverlayEvents();
    expect(document.activeElement).toBe(item('Close order'));
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await flushOverlayEvents();
    expect(isOpen()).toBe(true);
  });

  it('selects with a click, closes and returns the focus first; a disabled item does nothing', async () => {
    const { chosen, trigger, item, isOpen } = setup();
    fireEvent.click(trigger);
    await flushOverlayEvents();
    fireEvent.click(item('Edit'));
    await flushOverlayEvents();
    expect(chosen).not.toHaveBeenCalled();
    expect(isOpen()).toBe(true);
    let focusedWhenChosen: Element | null = null;
    chosen.mockImplementation(() => {
      focusedWhenChosen = document.activeElement;
    });
    fireEvent.click(item('Export CSV'));
    await flushOverlayEvents();
    expect(chosen).toHaveBeenCalledWith('export');
    expect(isOpen()).toBe(false);
    expect(focusedWhenChosen).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('puts the focus on the button before the choice acts, not waiting for the toggle event', async () => {
    const { chosen, trigger, menu, item } = setup();
    fireEvent.click(trigger);
    await flushOverlayEvents();
    // Browsers fire `toggle` later (a queued task): the stand-in's synchronous one is held back.
    const hide = vi.spyOn(menu, 'hidePopover').mockImplementation(() => {
      menu.removeAttribute('data-popover-open');
    });
    let focusedWhenChosen: Element | null = null;
    chosen.mockImplementation(() => {
      focusedWhenChosen = document.activeElement;
    });
    fireEvent.click(item('Print'));
    await flushOverlayEvents();
    expect(hide).toHaveBeenCalledTimes(1);
    expect(focusedWhenChosen).toBe(trigger);
    hide.mockRestore();
  });

  it('closes on Tab, the focus moving on from the button', async () => {
    const { trigger, menu, isOpen } = setup();
    fireEvent.click(trigger);
    await flushOverlayEvents();
    fireEvent.keyDown(menu, { key: 'Tab' });
    await flushOverlayEvents();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves the focus where an outside click put it', async () => {
    const { trigger, menu, isOpen } = setup();
    fireEvent.click(trigger);
    await flushOverlayEvents();
    const after = screen.getByRole('button', { name: 'After' });
    after.focus();
    menu.hidePopover();
    await flushOverlayEvents();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(after);
  });

  it('is an icon button when given an icon, named by its label', async () => {
    render(<Menu label="Row actions" icon="menu" items={[]} />);
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    expect(trigger.textContent).toBe('');
    expect(trigger.querySelector('svg[data-icon="menu"]')).not.toBeNull();
    fireEvent.click(trigger);
    await flushOverlayEvents();
    // No items: it opens, and the focus moves nowhere.
    expect(screen.getByRole('menu').hasAttribute('data-popover-open')).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  // UX-12 (#336): a menu of choices, and its icon button on the dark top bar.
  it('makes items with `checked` radio items with aria-checked and a check on the chosen one', async () => {
    const chosen = vi.fn();
    render(
      <Menu
        label="Theme"
        icon="sun"
        surface="dark"
        items={[
          {
            id: 'a',
            label: 'Alpha',
            checked: false,
            onSelect: () => {
              chosen('a');
            },
          },
          {
            id: 'b',
            label: 'Beta',
            checked: true,
            onSelect: () => {
              chosen('b');
            },
          },
          {
            id: 'c',
            label: 'Gamma',
            checked: false,
            onSelect: () => {
              chosen('c');
            },
          },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Theme' });
    // The dark top bar's control, not the light ghost button.
    expect(trigger.className).toContain('text-topbar-ink');
    expect(trigger.className).toContain('hover:bg-nav-hover');
    expect(trigger.className).not.toContain('text-accent');
    expect(trigger.getAttribute('title')).toBe('Theme');
    expect(trigger.querySelector('svg[data-icon="sun"]')).not.toBeNull();
    // The list is a light surface, so its ring is `focus`, not `focus-on-dark`.
    expect(screen.getByRole('menu').getAttribute('data-surface')).toBe('light');
    fireEvent.click(trigger);
    await flushOverlayEvents();
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    const radios = screen.getAllByRole('menuitemradio');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(radios.map((radio) => radio.querySelector('[data-icon="check"]') !== null)).toEqual([
      false,
      true,
      false,
    ]);
    // The arrows, End and the type-ahead move over radio items as over plain ones.
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(radios[1]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' });
    expect(document.activeElement).toBe(radios[2]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'a' });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Gamma' }));
    expect(chosen).toHaveBeenCalledWith('c');
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps plain items menuitem with no aria-checked', async () => {
    const { trigger, item } = setup();
    fireEvent.click(trigger);
    await flushOverlayEvents();
    expect(item('Print').hasAttribute('aria-checked')).toBe(false);
  });
});
