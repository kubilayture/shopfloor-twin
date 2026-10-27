import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { DataAttributes } from './badge.tsx';
import { Button, IconButton } from './button.tsx';
import { focusableIn } from './overlay.ts';

/**
 * A dialog (UX-1e, #317; design system 4.9) on the native `<dialog>` with `showModal()`: the
 * browser gives the top layer, the inert background (focus stays inside), Escape and the
 * backdrop. This component adds the rest:
 *
 * - the title as the `h2` that names it (`aria-labelledby`), the description that describes it
 *   (`aria-describedby`);
 * - focus to `initialFocus`, else the first control in the body or footer, else the close button;
 *   and back to the element that had it (the opener) when it closes;
 * - Escape and the close button ask the owner to close (`onClose`): the owner holds `open`;
 * - a click on the backdrop closes it only while nothing was typed in it, so a half-filled form
 *   is not lost to a stray click;
 * - the browser's own close (Chrome's close watcher closes a modal on a repeated Escape, a
 *   `cancel` that cannot be refused) is told to the owner, and if the owner still holds it open
 *   (a write is busy) the dialog opens again, so it never vanishes under an owner that thinks it
 *   is open (#352 review M3). Its `close` event arrives in a later task: one that follows the
 *   owner's own close is not taken for the browser's (H1).
 *
 * `variant="sheet"` is the full-height side sheet of list-and-detail screens below 1440 px
 * (design system 3.4): 440 px from the right, the full width below `md`. A detail sheet with no
 * form to start in passes `focusTitle`: the focus starts on its title (a static element at the
 * top, as the WAI-ARIA dialog pattern advises for a dialog of mostly content), not on the first
 * field, which would open a phone's keyboard. `data-*` pass through to the `<dialog>`, and
 * `closeTestId` names the close button, so a sheet keeps the test ids of the panel it stands in
 * for (`alarm-panel`, `data-alarm`, `close-alarm`). `size="touch"` is the operator terminal's
 * (UX-7, #330): a 20 px title, 16 px text and a 56 px close button.
 */
export type DialogSize = 'md' | 'touch';

/** Title, text and close button per size; written out in full for Tailwind. */
const SIZE = {
  md: { title: 'text-lg', text: 'text-sm', close: 'sm' },
  touch: { title: 'text-xl', text: 'text-base', close: 'touch' },
} as const;

export interface DialogProps extends DataAttributes {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly variant?: 'modal' | 'sheet' | undefined;
  readonly size?: DialogSize | undefined;
  readonly initialFocus?: RefObject<HTMLElement | null>;
  /** The focus starts on the title (made focusable by script only) instead of the first control. */
  readonly focusTitle?: boolean | undefined;
  /** The close button's test id. */
  readonly closeTestId?: string | undefined;
  /** Buttons, the primary last. */
  readonly footer?: ReactNode;
  readonly testId?: string | undefined;
  readonly children?: ReactNode;
}

/**
 * Whether a point is outside the dialog's box, so on its backdrop. A box with no size (jsdom has
 * no layout) does not decide: the target alone does. A sheet's empty lower part is the dialog
 * itself, not the backdrop (#352 review M2).
 */
function outside(element: HTMLElement, x: number, y: number): boolean {
  const box = element.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return true;
  return x < box.left || x > box.right || y < box.top || y > box.bottom;
}

const FRAME = {
  modal:
    'm-auto w-[min(30rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] rounded-lg ' +
    'motion-safe:transition-[opacity,translate] motion-safe:duration-base motion-safe:ease-standard ' +
    'starting:opacity-0 starting:translate-y-2',
  sheet:
    'my-0 mr-0 ml-auto h-dvh max-h-none w-full max-w-none md:w-[27.5rem] md:border-l md:border-line ' +
    'motion-safe:transition-[translate] motion-safe:duration-base motion-safe:ease-standard ' +
    'starting:translate-x-full',
} as const;

export function Dialog({
  open,
  onClose,
  title,
  description,
  variant = 'modal',
  size = 'md',
  initialFocus,
  focusTitle = false,
  closeTestId,
  footer,
  testId,
  children,
  ...data
}: DialogProps) {
  const look = SIZE[size];
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const typed = useRef(false);
  const pressedOnBackdrop = useRef(false);
  /** The owner's latest `open`, for the `close` event, which arrives a task after `close()`. */
  const wantOpen = useRef(open);
  useLayoutEffect(() => {
    wantOpen.current = open;
  });
  /** Counts the browser's closes the owner did not ask for: each one reopens it if still wanted. */
  const [nativeCloses, setNativeCloses] = useState(0);
  const titleId = useId();
  const descriptionId = useId();
  const requestClose = useEffectEvent(() => {
    onClose();
  });
  const focusOnOpen = useEffectEvent(() => {
    const first =
      initialFocus?.current ??
      (focusTitle ? heading.current : null) ??
      (content.current ? focusableIn(content.current)[0] : undefined) ??
      closeButton.current;
    first?.focus();
  });

  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    if (!open) return undefined;
    if (!element.open) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      typed.current = false;
      element.showModal();
      focusOnOpen();
    }
    return () => {
      // Closed by the owner, or unmounted while open: focus goes back to the opener.
      if (element.open) element.close();
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus();
    };
  }, [open]);

  // Closed by the browser while the owner still holds it open: open again where it was.
  useEffect(() => {
    const element = dialog.current;
    if (!element || nativeCloses === 0 || !open || element.open) return;
    element.showModal();
    focusOnOpen();
  }, [nativeCloses, open]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    // Escape: the browser would close it by itself; the owner decides instead.
    const onCancel = (event: Event) => {
      event.preventDefault();
      requestClose();
    };
    // Closed by the browser without a `cancel` the owner could refuse (Chrome closes on a second
    // Escape without user activation in between): the owner learns it is closed.
    const onNativeClose = () => {
      // The owner closed it (the event of its own `close()`, a task later): nothing to say.
      if (!wantOpen.current) return;
      // Open again by the time the event comes: it is the event of a `close()` already undone,
      // such as the opening effect's cleanup that StrictMode runs before running the effect
      // again (vite dev), not a close by the browser, which would leave it closed (#375).
      if (element.open) return;
      requestClose();
      setNativeCloses((n) => n + 1);
    };
    element.addEventListener('cancel', onCancel);
    element.addEventListener('close', onNativeClose);
    return () => {
      element.removeEventListener('cancel', onCancel);
      element.removeEventListener('close', onNativeClose);
    };
  }, []);

  return (
    <dialog
      {...data}
      ref={dialog}
      data-testid={testId}
      data-variant={variant}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      onInput={() => {
        typed.current = true;
      }}
      onPointerDown={(event) => {
        pressedOnBackdrop.current = event.target === dialog.current;
      }}
      onClick={(event) => {
        // The dialog's own box is covered by its content: a click on the element itself is on
        // the backdrop, and only counts when the press began there too (not a drag out of a field).
        const onBackdrop =
          event.target === dialog.current &&
          pressedOnBackdrop.current &&
          outside(dialog.current, event.clientX, event.clientY);
        pressedOnBackdrop.current = false;
        if (onBackdrop && !typed.current) onClose();
      }}
      className={`${FRAME[variant]} border-0 bg-surface p-0 text-ink shadow-elevation-3 backdrop:bg-backdrop`}
    >
      {open ? (
        <div className={`flex max-h-[inherit] flex-col${variant === 'sheet' ? ' h-full' : ''}`}>
          <header className="flex items-start justify-between gap-3 border-b border-line-subtle px-5 py-4">
            <div className="min-w-0">
              <h2
                ref={heading}
                id={titleId}
                {...(focusTitle ? { tabIndex: -1 } : {})}
                className={`${look.title} font-semibold`}
              >
                {title}
              </h2>
              {description === undefined ? null : (
                <div id={descriptionId} className={`mt-1 ${look.text} text-ink-secondary`}>
                  {description}
                </div>
              )}
            </div>
            <IconButton
              ref={closeButton}
              icon="close"
              label="Close"
              variant="ghost"
              size={look.close}
              data-testid={closeTestId}
              onClick={onClose}
            />
          </header>
          <div ref={content} className="flex min-h-0 flex-1 flex-col">
            {/* No empty body under a confirmation's description (UX-7 review, iPad check). */}
            {children === undefined || children === null ? null : (
              <div className={`min-h-0 flex-1 overflow-y-auto px-5 py-4 ${look.text}`}>
                {children}
              </div>
            )}
            {footer === undefined ? null : (
              <footer className="flex flex-wrap justify-end gap-2 border-t border-line-subtle px-5 py-3">
                {footer}
              </footer>
            )}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * A confirmation before an irreversible write (design system 4.9): the title asks the question
 * ("Close order PO-2610-303?"), the body says what happens and what cannot be undone, and the
 * confirm button repeats the verb ("Close order"), never "OK" or "Yes" (6.4). For `danger` the
 * focus starts on Cancel, so Enter alone does not destroy anything. While `pending` the confirm
 * button shows it is busy, and Escape and Cancel wait for the write.
 */
export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly body: ReactNode;
  readonly confirmLabel: string;
  readonly tone?: 'danger' | 'default' | undefined;
  readonly onConfirm: () => void | Promise<void>;
  readonly onCancel: () => void;
  readonly pending?: boolean | undefined;
  /** `touch`: the operator terminal's 56 px buttons and larger text (UX-7, #330). */
  readonly size?: DialogSize | undefined;
  readonly testId?: string | undefined;
}

/** Labels that say nothing about the act (design system 6.4). */
const VAGUE = new Set(['ok', 'okay', 'yes', 'submit', 'confirm', 'continue', 'done']);

/** The confirm label must be a verb the title repeats: "Close order" for "Close order PO-1?". */
export function confirmLabelProblem(title: string, confirmLabel: string): string | undefined {
  const label = confirmLabel.trim().toLowerCase();
  if (label === '' || VAGUE.has(label)) {
    return `ConfirmDialog "${title}": "${confirmLabel}" is not a verb; repeat the act (design system 6.4)`;
  }
  const verb = label.split(/\s+/)[0] ?? '';
  if (!title.toLowerCase().includes(verb)) {
    return `ConfirmDialog "${title}": the button "${confirmLabel}" must repeat the title's verb`;
  }
  return undefined;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone = 'default',
  onConfirm,
  onCancel,
  pending = false,
  size = 'md',
  testId,
}: ConfirmDialogProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  // A second activation while the first is on its way is ignored by the busy button; this also
  // covers a caller that does not pass `pending`.
  const [running, setRunning] = useState(false);
  const busy = pending || running;
  if (import.meta.env.DEV) {
    const problem = confirmLabelProblem(title, confirmLabel);
    if (problem) throw new Error(problem);
  }
  const ask = () => {
    if (!busy) onCancel();
  };
  return (
    <Dialog
      open={open}
      onClose={ask}
      title={title}
      description={body}
      size={size}
      initialFocus={tone === 'danger' ? cancel : confirm}
      testId={testId}
      footer={
        <>
          <Button
            ref={cancel}
            variant="secondary"
            size={size}
            onClick={ask}
            aria-disabled={busy || undefined}
          >
            Cancel
          </Button>
          <Button
            ref={confirm}
            variant={tone === 'danger' ? 'dangerSolid' : 'primary'}
            size={size}
            loading={busy}
            onClick={() => {
              const result = onConfirm();
              if (result instanceof Promise) {
                setRunning(true);
                const done = () => {
                  setRunning(false);
                };
                // A refused write is the caller's to show; here it only ends the busy state.
                result.then(done, done);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
