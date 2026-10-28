import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button, IconButton } from './button.tsx';
import { Icon, type IconName } from './icons.tsx';
import { positionPopover } from './overlay.ts';

/**
 * An overflow menu (UX-1e, #317; design system 4.13) on the menu-button pattern: a button with
 * `aria-haspopup="menu"` and `aria-expanded` opens a `role="menu"` list of `role="menuitem"`
 * buttons in a `popover="auto"` (light dismiss and Escape from the platform).
 *
 * Keyboard: Enter, Space or ArrowDown on the button open it on the first item, ArrowUp on the
 * last; in the menu the arrows move (wrapping), Home and End jump, a letter moves to the next
 * item starting with it, Enter and Space select, Escape closes, Tab closes and moves on. Focus
 * returns to the button when the menu closes from within. A disabled item is focusable but does
 * nothing (`aria-disabled`).
 *
 * For a page header or row with more than three actions. An action a spec clicks by test id
 * stays a visible button unless the spec moves with it (`testId` keeps the id on the item).
 *
 * A menu of choices (the theme switch, UX-12): items with `checked` are `menuitemradio` with
 * `aria-checked` and a check mark on the chosen one. `surface="dark"` draws the icon button for
 * the dark top bar (light icon, `nav-hover` under the pointer, the `focus-on-dark` ring).
 */
export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly tone?: 'default' | 'danger';
  readonly disabled?: boolean;
  readonly testId?: string | undefined;
  /** A choice of a set (`menuitemradio`): whether it is the chosen one. */
  readonly checked?: boolean | undefined;
}

export interface MenuProps {
  /** The button's accessible name, and its visible text unless `icon` is given. */
  readonly label: string;
  /** An icon-only button (the label is then its name and tooltip). */
  readonly icon?: IconName;
  readonly items: readonly MenuItem[];
  readonly align?: 'start' | 'end';
  readonly testId?: string | undefined;
  /**
   * The open list's name when the button's label carries a state ("Theme: Dark" names the button,
   * "Theme" the list, whose checked item says the state). By default the button's label.
   */
  readonly menuLabel?: string;
  /** The trigger's ground: `dark` for the top bar (an icon trigger only). */
  readonly surface?: 'light' | 'dark';
}

/** An icon trigger on the dark top bar: the shell's own control look (root-layout.tsx). */
const DARK_TRIGGER =
  'inline-flex size-9 shrink-0 items-center justify-center rounded-md text-topbar-ink hover:bg-nav-hover aria-expanded:bg-nav-hover motion-safe:transition-colors motion-safe:duration-fast';

/** Hidden until placed and focused by its `toggle` event, which comes a task after it opens. */
const UNPLACED = '[&:not([data-placed])]:invisible';

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return [
    ...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? []),
  ];
}

/**
 * The index an opening menu focuses: the last for ArrowUp; otherwise the checked radio item, as
 * the WAI-ARIA menu pattern has it for a choice (#391), else the first.
 */
function openingIndex(menu: HTMLElement | null, from: 'first' | 'last'): number {
  if (from === 'last') return -1;
  const checked = menuItems(menu).findIndex((item) => item.getAttribute('aria-checked') === 'true');
  return Math.max(checked, 0);
}

/** Focuses the item at `index`, wrapping: -1 is the last. */
function focusItem(menu: HTMLElement | null, index: number): void {
  const all = menuItems(menu);
  if (all.length === 0) return;
  all[(index + all.length) % all.length]?.focus();
}

export function Menu({
  label,
  icon,
  items,
  align = 'start',
  testId,
  surface = 'light',
  menuLabel,
}: MenuProps) {
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  /** Which item takes focus once the menu has opened: the first, the last, or none (a click). */
  const focusOnOpen = useRef<'first' | 'last'>('first');

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return undefined;
    const onToggle = (event: Event) => {
      const opened = (event as Event & { newState?: string }).newState === 'open';
      setOpen(opened);
      // Placed, then shown: the popover opened a task before this event (#352 review H1).
      element.toggleAttribute('data-placed', opened);
      if (opened) {
        if (trigger.current) positionPopover(trigger.current, element, { side: 'bottom', align });
        focusItem(element, openingIndex(element, focusOnOpen.current));
        focusOnOpen.current = 'first';
        return;
      }
      // Closed from within (Escape, a choice, Tab handled below): focus back on the button. A
      // click elsewhere leaves the focus where that click put it.
      const active = document.activeElement;
      if (active === document.body || (active !== null && element.contains(active))) {
        trigger.current?.focus();
      }
    };
    element.addEventListener('toggle', onToggle);
    return () => {
      element.removeEventListener('toggle', onToggle);
    };
  }, [align]);

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    focusOnOpen.current = event.key === 'ArrowUp' ? 'last' : 'first';
    if (open) focusItem(menu.current, event.key === 'ArrowUp' ? -1 : 0);
    else menu.current?.showPopover();
  };

  const close = () => {
    menu.current?.hidePopover();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = menuItems(menu.current);
    const at = all.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItem(menu.current, at + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(menu.current, at - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusItem(menu.current, 0);
        return;
      case 'End':
        event.preventDefault();
        focusItem(menu.current, -1);
        return;
      case 'Tab':
        // Out of the menu: it closes, and the focus moves on from the button.
        trigger.current?.focus();
        close();
        return;
      default:
        break;
    }
    // Type-ahead: a printable letter moves to the next item that starts with it.
    if (
      event.key.length === 1 &&
      /\S/.test(event.key) &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const letter = event.key.toLowerCase();
      for (let step = 1; step <= all.length; step += 1) {
        const index = (at + step) % all.length;
        if (all[index]?.textContent.trim().toLowerCase().startsWith(letter)) {
          event.preventDefault();
          focusItem(menu.current, index);
          return;
        }
      }
    }
  };

  const common = {
    ref: trigger,
    popoverTarget: menuId,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': menuId,
    onKeyDown: onTriggerKey,
    'data-testid': testId,
  };

  return (
    <>
      {icon === undefined ? (
        <Button variant="secondary" {...common}>
          {label}
          <Icon name="chevron-down" size={16} />
        </Button>
      ) : surface === 'dark' ? (
        <button type="button" aria-label={label} title={label} className={DARK_TRIGGER} {...common}>
          <Icon name={icon} size={20} />
        </button>
      ) : (
        <IconButton icon={icon} label={label} variant="ghost" {...common} />
      )}
      <div
        ref={menu}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label={menuLabel ?? label}
        // A light surface even when the trigger sits on the dark top bar: the ring is `focus`.
        data-surface="light"
        onKeyDown={onMenuKey}
        className={`${UNPLACED} m-0 inset-auto min-w-44 rounded-lg border border-line bg-surface p-1 text-sm text-ink shadow-elevation-2`}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            tabIndex={-1}
            data-testid={item.testId}
            aria-disabled={item.disabled === true ? true : undefined}
            onClick={() => {
              if (item.disabled) return;
              // Focus is back on the button before the choice acts, so a dialog it opens
              // returns the focus there, not to a hidden item.
              trigger.current?.focus();
              close();
              item.onSelect();
            }}
            className={[
              'flex min-h-8 w-full items-center gap-2 rounded-md px-3 text-left',
              item.disabled
                ? 'cursor-not-allowed text-disabled-ink'
                : item.tone === 'danger'
                  ? 'text-alarm-ink hover:bg-alarm-soft focus-visible:bg-alarm-soft'
                  : 'hover:bg-surface-hover focus-visible:bg-surface-hover',
            ].join(' ')}
          >
            {item.checked === undefined ? null : (
              // The chosen one's check; the others keep its room, so the labels line up.
              <span className="inline-flex size-4 shrink-0 text-accent">
                {item.checked ? <Icon name="check" size={16} /> : null}
              </span>
            )}
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
