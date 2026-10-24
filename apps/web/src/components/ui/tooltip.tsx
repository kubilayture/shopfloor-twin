import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { IconButton } from './button.tsx';
import { Icon } from './icons.tsx';
import { hasPopover, positionPopover } from './overlay.ts';

/**
 * Tooltip and InfoTip (UX-1e, #317; design system 4.12).
 *
 * `Tooltip` is a supplement, never the only place a fact lives (touch has no hover). It shows on
 * hover and on keyboard focus after 400 ms, stays while the pointer is over it (WCAG 1.4.13
 * hoverable), hides on Escape without moving focus or pointer (dismissible), and its trigger is
 * described by it (`aria-describedby`). A `popover="manual"` element in the top layer, placed by
 * script. Escape that hides it does only that: inside a dialog it does not also close the dialog
 * (WCAG 1.4.13). Without the Popover API (before Safari 17, outside the supported browsers) no
 * tooltip is rendered at all, since an unknown `popover` would show it inline for good; the
 * trigger's own text stands.
 *
 * `InfoTip` is a 28 px "i" button that toggles a `popover="auto"` panel with a longer explanation:
 * light dismiss and Escape from the platform, by click, keyboard and touch alike. The panel stays
 * invisible until it is placed (its `toggle` event comes a task after it opens). Without the
 * Popover API it is a `<details>` instead, open in place.
 */
export const TOOLTIP_DELAY_MS = 400;
/** Grace to move the pointer from the trigger onto the tooltip. */
const HIDE_GRACE_MS = 100;

export interface TooltipProps {
  readonly content: string;
  /** One element that takes focus (a button, a link); it gets `aria-describedby`. */
  readonly children: ReactElement<{ 'aria-describedby'?: string }>;
  readonly side?: 'top' | 'bottom';
}

const PANEL =
  'm-0 inset-auto overflow-visible rounded-md border border-line bg-surface text-ink shadow-elevation-2';
/** Hidden until placed: the popover is shown a task before its `toggle` event places it. */
const UNPLACED = '[&:not([data-placed])]:invisible';

export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const supported = hasPopover();

  const clear = () => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
  };
  const show = () => {
    clear();
    showTimer.current = setTimeout(() => {
      setOpen(true);
    }, TOOLTIP_DELAY_MS);
  };
  const hide = (grace: boolean) => {
    clear();
    if (grace) {
      hideTimer.current = setTimeout(() => {
        setOpen(false);
      }, HIDE_GRACE_MS);
    } else setOpen(false);
  };

  // A layout effect: placed before the browser paints it, so it never shows at the wrong spot.
  useLayoutEffect(() => {
    const element = tip.current;
    if (!element || !anchor.current || !hasPopover()) return undefined;
    if (!open) {
      element.hidePopover();
      return undefined;
    }
    element.showPopover();
    positionPopover(anchor.current, element, { side, align: 'center' });
    // Captured, and stopped: this Escape hides the tooltip and nothing else (not a dialog).
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(showTimer.current);
        setOpen(false);
      }
    };
    const onScroll = () => {
      setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, side]);

  useEffect(
    () => () => {
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
    },
    [],
  );

  if (!supported) return children;
  return (
    <>
      <span
        ref={anchor}
        className="inline-flex"
        onPointerEnter={show}
        onPointerLeave={() => {
          hide(true);
        }}
        onFocus={show}
        onBlur={() => {
          hide(false);
        }}
      >
        {cloneElement(children, {
          'aria-describedby': [children.props['aria-describedby'], id].filter(Boolean).join(' '),
        })}
      </span>
      <div
        ref={tip}
        id={id}
        role="tooltip"
        popover="manual"
        data-open={open}
        onPointerEnter={clear}
        onPointerLeave={() => {
          hide(true);
        }}
        className={`${PANEL} max-w-xs px-2 py-1 text-xs`}
      >
        {content}
      </div>
    </>
  );
}

export interface InfoTipProps {
  /** The button's accessible name: "About line OEE". */
  readonly label: string;
  readonly children: ReactNode;
}

export function InfoTip({ label, children }: InfoTipProps) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return undefined;
    const onToggle = (event: Event) => {
      const opened = (event as Event & { newState?: string }).newState === 'open';
      setOpen(opened);
      if (opened && button.current) {
        positionPopover(button.current, element, { side: 'bottom', align: 'start' });
      }
      element.toggleAttribute('data-placed', opened);
    };
    element.addEventListener('toggle', onToggle);
    return () => {
      element.removeEventListener('toggle', onToggle);
    };
  }, []);

  if (!hasPopover()) {
    return (
      <details className="group inline-block align-middle text-sm">
        <summary
          aria-label={label}
          title={label}
          className="inline-flex size-7 cursor-pointer list-none items-center justify-center rounded-md text-accent hover:bg-surface-hover [&::-webkit-details-marker]:hidden"
        >
          <Icon name="info" size={16} />
        </summary>
        <div className="mt-1 rounded-md border border-line bg-surface p-3">{children}</div>
      </details>
    );
  }
  return (
    <>
      <IconButton
        ref={button}
        icon="info"
        label={label}
        variant="ghost"
        size="sm"
        popoverTarget={id}
        aria-expanded={open}
        aria-controls={id}
      />
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="note"
        aria-label={label}
        className={`${PANEL} ${UNPLACED} w-[min(20rem,calc(100vw-1rem))] p-3 text-sm`}
      >
        {children}
      </div>
    </>
  );
}
