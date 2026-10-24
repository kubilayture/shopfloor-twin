/**
 * Helpers the overlays share (UX-1e, #317; design system 4.12 to 4.14): where a popover sits next
 * to its trigger, and the focusable elements of a container.
 *
 * Positioning is by script, for every browser: CSS anchor positioning is an enhancement the
 * design system does not require (Firefox lacks it), and one way is easier to keep right. A
 * popover is in the top layer with `position: fixed`, so viewport coordinates from
 * `getBoundingClientRect` place it; the values go through the CSSOM (`style.setProperty`), which
 * the CSP (`style-src 'self'`) allows, unlike a `style` attribute in markup.
 */

/** Space between the trigger and the popover, and the least gap to the viewport's edge (px). */
const GAP = 6;
const EDGE = 8;

export interface Placement {
  /** Above or below the trigger; flipped when that side has no room and the other has more. */
  readonly side: 'top' | 'bottom';
  /** Lined up with the trigger's start or end edge, or centred on it. */
  readonly align: 'start' | 'end' | 'center';
}

export interface Rect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

/** The popover's top-left corner in viewport pixels, kept inside the viewport. */
export function placeBeside(
  trigger: Rect,
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  { side, align }: Placement,
): { readonly top: number; readonly left: number; readonly side: 'top' | 'bottom' } {
  const above = trigger.top - GAP - EDGE;
  const below = viewport.height - trigger.bottom - GAP - EDGE;
  const fits = side === 'top' ? above >= size.height : below >= size.height;
  const chosen = fits ? side : above > below ? 'top' : 'bottom';
  const top = chosen === 'top' ? trigger.top - GAP - size.height : trigger.bottom + GAP;
  const wanted =
    align === 'start'
      ? trigger.left
      : align === 'end'
        ? trigger.right - size.width
        : trigger.left + trigger.width / 2 - size.width / 2;
  const left = Math.max(EDGE, Math.min(wanted, viewport.width - size.width - EDGE));
  return { top: Math.max(EDGE, top), left, side: chosen };
}

/** Moves `popover` next to `trigger`; returns the side it went to. */
export function positionPopover(
  trigger: Element,
  popover: HTMLElement,
  placement: Placement,
): 'top' | 'bottom' {
  const box = popover.getBoundingClientRect();
  const at = placeBeside(
    trigger.getBoundingClientRect(),
    { width: box.width, height: box.height },
    { width: window.innerWidth, height: window.innerHeight },
    placement,
  );
  popover.style.setProperty('top', `${String(Math.round(at.top))}px`);
  popover.style.setProperty('left', `${String(Math.round(at.left))}px`);
  return at.side;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** The elements in `root` that take focus with Tab, in document order. */
export function focusableIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest('[inert]'),
  );
}

/** True when the Popover API is there (Safari 17+, Chrome 114+, Firefox 125+). */
export function hasPopover(): boolean {
  return typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;
}
