import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import type { DataAttributes } from './badge.tsx';
import { IconButton } from './button.tsx';
import { Dialog } from './dialog.tsx';

/**
 * The detail of a list-and-detail screen (UX-4a, #324; design system 3.4): from `wide` (1440 px)
 * a sticky side panel of 400 px beside the list, `top: 64px`, as tall as the viewport and
 * scrolling itself; below it, 1280 included (the specs' and the demo's width), a full-height side
 * sheet (`Dialog` `variant="sheet"`) over the list. The owner renders it only while an item is
 * chosen, so with nothing chosen the list takes the full width (G-26).
 *
 * Both are named by their `h2` title, which takes the focus when the detail opens (and again when
 * another item is opened into the open panel, `focusKey`); Escape and the close button ask the
 * owner to close (`onClose`), and the focus goes back to the control that opened it, else to
 * `returnFocus()` (the list's heading, when the opener left with its row). `data-*`, `testId` and
 * `closeTestId` are on the panel and the sheet alike, so the tests find one detail at any width.
 */

/** `wide`: the side panel's breakpoint (`--breakpoint-wide: 90rem`). */
export const WIDE_QUERY = '(min-width: 90rem)';

function subscribeWide(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

/** Without `matchMedia` (jsdom) the screen counts as wide: the panel, not the sheet. */
const isWide = () =>
  typeof window.matchMedia !== 'function' || window.matchMedia(WIDE_QUERY).matches;

/** Whether the screen is at least `wide` (1440 px): the detail is a side panel there. */
export function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, isWide, () => true);
}

export interface DetailPanelProps extends DataAttributes {
  /** The item's name: the `h2`. */
  readonly title: ReactNode;
  /** One line under the title (the item's place and code). */
  readonly description?: ReactNode;
  readonly onClose: () => void;
  /** The panel title's id (a "Skip to the details" link points at it). */
  readonly titleId: string;
  /** Another item opened into the open panel: its title takes the focus again. */
  readonly focusKey?: string | undefined;
  /** Where the focus goes on close when the opener is gone. */
  readonly returnFocus?: (() => HTMLElement | null) | undefined;
  readonly testId?: string | undefined;
  readonly closeTestId?: string | undefined;
  /** The close button's accessible name. */
  readonly closeLabel?: string;
  readonly children: ReactNode;
}

export function DetailPanel(props: DetailPanelProps) {
  const wide = useWide();
  const {
    title,
    description,
    onClose,
    titleId,
    focusKey,
    returnFocus,
    testId,
    closeTestId,
    closeLabel = 'Close the details',
    children,
    ...data
  } = props;
  if (!wide) {
    return (
      <Dialog
        {...data}
        open
        variant="sheet"
        title={title}
        description={description}
        onClose={onClose}
        focusTitle
        testId={testId}
        closeTestId={closeTestId}
      >
        {children}
      </Dialog>
    );
  }
  return (
    <SidePanel
      {...data}
      title={title}
      description={description}
      onClose={onClose}
      titleId={titleId}
      focusKey={focusKey}
      returnFocus={returnFocus}
      testId={testId}
      closeTestId={closeTestId}
      closeLabel={closeLabel}
    >
      {children}
    </SidePanel>
  );
}

function SidePanel({
  title,
  description,
  onClose,
  titleId,
  focusKey,
  returnFocus,
  testId,
  closeTestId,
  closeLabel = 'Close the details',
  children,
  ...data
}: DetailPanelProps) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const fallback = useRef(returnFocus);
  useEffect(() => {
    fallback.current = returnFocus;
  });

  // Opened, or another item opened into it: remember who opened it, then focus the title.
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !panel.current?.contains(active)) {
      opener.current = active === document.body ? null : active;
    }
    heading.current?.focus();
  }, [focusKey]);

  // Closed (unmounted): back to the opener, else the owner's fallback.
  useEffect(
    () => () => {
      const back = opener.current?.isConnected ? opener.current : fallback.current?.();
      if (back?.isConnected) back.focus();
    },
    [],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };

  return (
    <section
      {...data}
      ref={panel}
      aria-labelledby={titleId}
      data-testid={testId}
      data-variant="panel"
      onKeyDown={onKeyDown}
      className="sticky top-16 flex max-h-[calc(100dvh-5rem)] min-w-0 flex-col rounded-lg border border-line bg-surface shadow-elevation-1"
    >
      <header className="flex items-start justify-between gap-3 border-b border-line-subtle px-5 py-4">
        <div className="min-w-0">
          <h2 ref={heading} id={titleId} tabIndex={-1} className="text-lg font-semibold text-ink">
            {title}
          </h2>
          {description === undefined ? null : (
            <div className="mt-1 text-sm text-ink-secondary">{description}</div>
          )}
        </div>
        <IconButton
          icon="close"
          label={closeLabel}
          variant="ghost"
          size="sm"
          data-testid={closeTestId}
          onClick={onClose}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm">{children}</div>
    </section>
  );
}
