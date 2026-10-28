import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import { LOGOUT_PENDING_KEY } from '../auth/pending-logout.ts';

// Role queries otherwise compute every element's style to skip hidden ones, which makes them
// slow in jsdom, the more so on a busy CI runner; these tests render no hidden content to skip.
// `findBy*` and `waitFor` retry until they pass; a little above their 1 s default, for a loaded
// machine (#212). A call that waits for something slow by design names its own deadline.
configure({ defaultHidden: true, asyncUtilTimeout: 3_000 });

afterEach(() => {
  cleanup();
  modalDialogs.length = 0;
  autoPopovers.length = 0;
  // Each test is a new tab: a logout one left on its way (`LOGOUT_PENDING_KEY`, #390) must not
  // end the next test's session.
  try {
    globalThis.sessionStorage.removeItem(LOGOUT_PENDING_KEY);
  } catch {
    // no storage, or a test's stand-in that refuses
  }
});

// jsdom has no layout; the router restores scroll positions on navigation.
window.scrollTo = () => undefined;

/*
 * Stand-ins for the platform features the overlays are built on (UX-1e, #317; design system
 * 4.14), which jsdom does not implement. They give the state, the events and the attributes, so
 * unit tests check roles, names, `aria-*`, events and focus calls; focus containment, the inert
 * background and light dismiss are checked in a real browser by the UX-1g harness.
 *
 * - `<dialog>`: `showModal`/`show` set `open`, `close` clears it, sets `returnValue` and fires
 *   `close` in a later task (`setTimeout` 0), as the browser queues it; Escape fires a cancelable
 *   `cancel` at the top modal dialog at once and closes it unless the handler prevented that.
 * - Popover: `showPopover`/`hidePopover`/`togglePopover` set and clear `data-popover-open` (the
 *   stand-in for `:popover-open`, which jsdom's selector engine does not know) at once and fire
 *   `toggle` with `oldState`/`newState` in a later task, as the browser does (#352 review H1); a
 *   click on a `popovertarget` button toggles its popover, and Escape hides the last
 *   `popover="auto"` one shown. No light dismiss on outside clicks.
 *
 * A test that waits for those events flushes them (`flushOverlayEvents` in `test/overlay.ts`).
 * - `inert`: only the attribute, reflected by the property.
 */
const modalDialogs: HTMLDialogElement[] = [];
const autoPopovers: HTMLElement[] = [];

const POPOVER_OPEN = 'data-popover-open';

function toggleEvent(oldState: 'open' | 'closed', newState: 'open' | 'closed'): Event {
  return Object.assign(new Event('toggle'), { oldState, newState });
}

const dialogProto = HTMLDialogElement.prototype as HTMLDialogElement & {
  showModal?: () => void;
};
dialogProto.showModal = function showModal(this: HTMLDialogElement) {
  if (this.hasAttribute('open')) return;
  this.setAttribute('open', '');
  modalDialogs.push(this);
};
dialogProto.show = function show(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
dialogProto.close = function close(this: HTMLDialogElement, returnValue?: string) {
  if (!this.hasAttribute('open')) return;
  this.removeAttribute('open');
  const at = modalDialogs.indexOf(this);
  if (at >= 0) modalDialogs.splice(at, 1);
  if (returnValue !== undefined) this.returnValue = returnValue;
  setTimeout(() => {
    this.dispatchEvent(new Event('close'));
  }, 0);
};

const elementProto = HTMLElement.prototype as HTMLElement & {
  showPopover: () => void;
  hidePopover: () => void;
  togglePopover: (force?: boolean) => boolean;
};
elementProto.showPopover = function showPopover(this: HTMLElement) {
  if (this.hasAttribute(POPOVER_OPEN)) return;
  this.setAttribute(POPOVER_OPEN, '');
  if (this.getAttribute('popover') !== 'manual') autoPopovers.push(this);
  setTimeout(() => {
    this.dispatchEvent(toggleEvent('closed', 'open'));
  }, 0);
};
elementProto.hidePopover = function hidePopover(this: HTMLElement) {
  if (!this.hasAttribute(POPOVER_OPEN)) return;
  this.removeAttribute(POPOVER_OPEN);
  const at = autoPopovers.indexOf(this);
  if (at >= 0) autoPopovers.splice(at, 1);
  setTimeout(() => {
    this.dispatchEvent(toggleEvent('open', 'closed'));
  }, 0);
};
elementProto.togglePopover = function togglePopover(this: HTMLElement, force?: boolean) {
  const open = force ?? !this.hasAttribute(POPOVER_OPEN);
  if (open) this.showPopover();
  else this.hidePopover();
  return open;
};

Object.defineProperty(HTMLElement.prototype, 'inert', {
  configurable: true,
  get(this: HTMLElement) {
    return this.hasAttribute('inert');
  },
  set(this: HTMLElement, value: boolean) {
    this.toggleAttribute('inert', value);
  },
});

document.addEventListener('click', (event) => {
  const invoker =
    event.target instanceof Element ? event.target.closest('[popovertarget]') : undefined;
  if (!invoker || (invoker as HTMLButtonElement).disabled) return;
  const target = document.getElementById(invoker.getAttribute('popovertarget') ?? '');
  if (target) (target as typeof elementProto).togglePopover();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const popover = autoPopovers.at(-1);
  if (popover) {
    (popover as typeof elementProto).hidePopover();
    return;
  }
  const dialog = modalDialogs.at(-1);
  if (!dialog) return;
  const cancel = new Event('cancel', { cancelable: true });
  if (dialog.dispatchEvent(cancel)) dialog.close();
});
