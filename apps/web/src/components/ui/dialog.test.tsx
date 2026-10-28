import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useRef, useState } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { flushOverlayEvents } from '../../test/overlay.ts';
import { ConfirmDialog, Dialog, confirmLabelProblem } from './dialog.tsx';
import { Tooltip } from './tooltip.tsx';

/** UX-1e (#317): design system 4.9, over the `<dialog>` stand-ins of `src/test/setup.ts`. */

function Harness({
  variant,
  withInitialFocus = false,
  onClose,
}: {
  readonly variant?: 'modal' | 'sheet';
  readonly withInitialFocus?: boolean;
  readonly onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const note = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Edit note
      </button>
      <Dialog
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Edit the note"
        description="The shift sees it at handover."
        variant={variant}
        testId="note-dialog"
        {...(withInitialFocus ? { initialFocus: note } : {})}
        footer={
          <>
            <button type="button">Cancel</button>
            <button type="button">Save note</button>
          </>
        }
      >
        <label>
          Title <input />
        </label>
        <label>
          Text <textarea ref={note} />
        </label>
      </Dialog>
    </>
  );
}

const dialogEl = () => screen.getByTestId<HTMLDialogElement>('note-dialog');

function openIt() {
  const opener = screen.getByRole('button', { name: 'Edit note' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe('Dialog', () => {
  it('opens modal, named by its title and described by its description, focus on the first field', () => {
    render(<Harness />);
    expect(dialogEl().open).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Edit the note' })).toBeNull();
    openIt();
    const dialog = screen.getByRole('dialog', { name: 'Edit the note' });
    expect(dialog).toBe(dialogEl());
    expect(dialogEl().open).toBe(true);
    expect(screen.getByRole('heading', { level: 2, name: 'Edit the note' }).id).toBe(
      dialog.getAttribute('aria-labelledby'),
    );
    const described = document.getElementById(dialog.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe('The shift sees it at handover.');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Title' }));
    expect(dialog.dataset.variant).toBe('modal');
    expect(dialog.className).toContain('backdrop:bg-backdrop');
  });

  it('focuses initialFocus when given, and returns focus to the opener on close', () => {
    render(<Harness withInitialFocus />);
    const opener = openIt();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(dialogEl().open).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('starts on its title with focusTitle, and passes data-* and the close button test id', () => {
    function Sheet() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Details
          </button>
          <Dialog
            open={open}
            onClose={() => {
              setOpen(false);
            }}
            title="Coolant pressure low"
            variant="sheet"
            focusTitle
            testId="note-dialog"
            closeTestId="close-alarm"
            data-alarm="a1"
          >
            <label>
              Comment <input />
            </label>
          </Dialog>
        </>
      );
    }
    render(<Sheet />);
    const opener = screen.getByRole('button', { name: 'Details' });
    opener.focus();
    fireEvent.click(opener);
    const title = screen.getByRole('heading', { level: 2, name: 'Coolant pressure low' });
    expect(document.activeElement).toBe(title);
    expect(title.getAttribute('tabindex')).toBe('-1');
    expect(dialogEl().dataset.alarm).toBe('a1');
    fireEvent.click(screen.getByTestId('close-alarm'));
    expect(dialogEl().open).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('leaves the title out of the Tab order without focusTitle', () => {
    render(<Harness />);
    openIt();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Edit the note' }).hasAttribute('tabindex'),
    ).toBe(false);
  });

  it('asks the owner to close on Escape instead of closing by itself', () => {
    const onClose = vi.fn();
    function Stubborn() {
      return (
        <Dialog open onClose={onClose} title="Stays" testId="note-dialog">
          <button type="button">Inside</button>
        </Dialog>
      );
    }
    render(<Stubborn />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    // The owner kept it open: the cancel was refused, so the dialog is still open.
    expect(dialogEl().open).toBe(true);
  });

  it('closes on Escape through the owner, with the focus back on the opener', () => {
    render(<Harness />);
    const opener = openIt();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(dialogEl().open).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('tells the owner when the browser closed it without a cancel', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    openIt();
    act(() => {
      dialogEl().close();
    });
    // The close event comes a task later, as in the browser.
    expect(onClose).not.toHaveBeenCalled();
    await flushOverlayEvents();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'Edit the note' })).toBeNull();
  });

  it("does not take the close event of the owner's own close for the browser's (#352 H1)", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    openIt();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await flushOverlayEvents();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open when it mounts open under StrictMode, and still hears the browser close it (#375)', async () => {
    // A detail sheet mounts open (`?record=` in the URL). StrictMode (vite dev) runs the opening
    // effect, its cleanup (`close()`) and the effect again: the cleanup's `close` event comes a
    // task later, to a dialog open again, and must not close it.
    const onClose = vi.fn();
    render(
      <StrictMode>
        <Dialog open onClose={onClose} title="Record DT-7" variant="sheet" testId="note-dialog">
          <p>Details</p>
        </Dialog>
      </StrictMode>,
    );
    await flushOverlayEvents();
    await flushOverlayEvents();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogEl().open).toBe(true);
    expect(screen.getByRole('heading', { name: 'Record DT-7' })).toBeTruthy();
    // The browser's own close is still told to the owner.
    act(() => {
      dialogEl().close();
    });
    await flushOverlayEvents();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a click on the empty lower part of a sheet is not on the backdrop (#352 M2)', () => {
    const onClose = vi.fn();
    render(<Harness variant="sheet" onClose={onClose} />);
    openIt();
    // The content fills the sheet's height, so its lower part is the content, not the dialog.
    expect(dialogEl().firstElementChild?.className).toMatch(/\bh-full\b/);
    // A sheet 440 px wide on the right of a 1280 px viewport, the full height.
    vi.spyOn(dialogEl(), 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 840, y: 0, width: 440, height: 800 }),
    );
    fireEvent.pointerDown(dialogEl(), { clientX: 1000, clientY: 700 });
    fireEvent.click(dialogEl(), { clientX: 1000, clientY: 700 });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(dialogEl(), { clientX: 400, clientY: 300 });
    fireEvent.click(dialogEl(), { clientX: 400, clientY: 300 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('holds the page still behind a modal (#352 L3)', () => {
    const css = readFileSync(join(import.meta.dirname, '..', '..', 'index.css'), 'utf8');
    expect(css).toMatch(/html:has\(dialog:modal\)\s*\{\s*overflow: hidden;/);
  });

  it("keeps the scrollbar's room while it holds the page still, so nothing shifts (#339)", () => {
    const css = readFileSync(join(import.meta.dirname, '..', '..', 'index.css'), 'utf8');
    expect(css).toMatch(/\nhtml \{[^}]*scrollbar-gutter: stable;/);
  });

  it('Escape on a tooltip inside it hides the tooltip only (#352 L6)', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Order" testId="note-dialog">
        <Tooltip content="13/16 exactly">
          <button type="button">81.3 %</button>
        </Tooltip>
      </Dialog>,
    );
    const trigger = screen.getByRole('button', { name: '81.3 %' });
    fireEvent.focus(trigger);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole('tooltip').dataset.open).toBe('true');
    const below = vi.fn();
    trigger.parentElement?.addEventListener('keydown', below);
    // Its default prevented (no close request) and stopped before anything else hears it.
    expect(fireEvent.keyDown(trigger, { key: 'Escape' })).toBe(false);
    expect(below).not.toHaveBeenCalled();
    expect(screen.getByRole('tooltip').dataset.open).toBe('false');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('closes on a backdrop click only while nothing was typed, and not after a drag out of a field', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    openIt();
    // A press inside released on the backdrop: not a backdrop click.
    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Title' }));
    fireEvent.click(dialogEl());
    expect(onClose).not.toHaveBeenCalled();
    // A click inside the content: not on the backdrop.
    fireEvent.pointerDown(screen.getByText('The shift sees it at handover.'));
    fireEvent.click(screen.getByText('The shift sees it at handover.'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(dialogEl());
    fireEvent.click(dialogEl());
    expect(onClose).toHaveBeenCalledTimes(1);

    openIt();
    fireEvent.input(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'half' } });
    fireEvent.pointerDown(dialogEl());
    fireEvent.click(dialogEl());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialogEl().open).toBe(true);
  });

  it('is a side sheet when asked', () => {
    render(<Harness variant="sheet" />);
    openIt();
    expect(dialogEl().dataset.variant).toBe('sheet');
    expect(dialogEl().className).toMatch(/\bh-dvh\b/);
    expect(dialogEl().className).toMatch(/\bmd:w-\[27\.5rem\]/);
    expect(dialogEl().className).toMatch(/motion-safe:transition/);
  });

  it('focuses the close button when there is nothing else to focus, and lets go when unmounted', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <Dialog open onClose={() => undefined} title="Note" testId="note-dialog">
        <p>Read only.</p>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    expect(dialogEl().hasAttribute('aria-describedby')).toBe(false);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

function Confirm({
  tone,
  pending,
  size,
  onConfirm,
  onCancel,
}: {
  readonly tone?: 'danger' | 'default';
  readonly pending?: boolean;
  readonly size?: 'md' | 'touch';
  readonly onConfirm: () => void | Promise<void>;
  readonly onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open
      title="Close order PO-2610-303?"
      body="Its open quantity is cancelled. A closed order cannot be opened again."
      confirmLabel="Close order"
      tone={tone}
      pending={pending}
      size={size}
      onConfirm={onConfirm}
      onCancel={onCancel}
      testId="confirm"
    />
  );
}

describe('ConfirmDialog', () => {
  it('asks with the title, says what happens and repeats the verb; danger starts on Cancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<Confirm tone="danger" onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = screen.getByRole('dialog', { name: 'Close order PO-2610-303?' });
    expect(
      document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Its open quantity is cancelled. A closed order cannot be opened again.');
    const confirm = screen.getByRole('button', { name: 'Close order' });
    expect(confirm.className).toContain('bg-alarm-solid');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('starts on the confirm button for a default confirmation, drawn primary', () => {
    render(<Confirm onConfirm={() => undefined} onCancel={() => undefined} />);
    const confirm = screen.getByRole('button', { name: 'Close order' });
    expect(document.activeElement).toBe(confirm);
    expect(confirm.className).toContain('bg-accent');
  });

  it('has no empty body between its description and its buttons (UX-7 iPad check)', () => {
    render(<Confirm onConfirm={() => undefined} onCancel={() => undefined} />);
    const dialog = screen.getByRole('dialog', { name: 'Close order PO-2610-303?' });
    expect(dialog.querySelector('.overflow-y-auto')).toBeNull();
    expect(dialog.querySelector('footer')).not.toBeNull();
  });

  it('has 56 px buttons, a 56 px close button and larger text at the touch size (UX-7)', () => {
    const { unmount } = render(<Confirm onConfirm={() => undefined} onCancel={() => undefined} />);
    const heights = () =>
      ['Cancel', 'Close order', 'Close'].map((name) =>
        screen
          .getByRole('button', { name })
          .className.split(/\s+/)
          .find((c) => c.startsWith('min-h-')),
      );
    expect(heights()).toEqual(['min-h-9', 'min-h-9', 'min-h-7']);
    expect(screen.getByRole('heading', { name: 'Close order PO-2610-303?' }).className).toContain(
      'text-lg',
    );
    unmount();
    render(<Confirm size="touch" onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(heights()).toEqual(['min-h-14', 'min-h-14', 'min-h-14']);
    expect(screen.getByRole('heading', { name: 'Close order PO-2610-303?' }).className).toContain(
      'text-xl',
    );
    const dialog = screen.getByRole('dialog');
    expect(
      document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.className,
    ).toContain('text-base');
  });

  it('while pending: busy confirm, and neither Escape nor Cancel closes it', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<Confirm tone="danger" pending onConfirm={onConfirm} onCancel={onCancel} />);
    const confirm = screen.getByRole('button', { name: 'Close order' });
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId<HTMLDialogElement>('confirm').open).toBe(true);
  });

  it('is busy by itself while the promise onConfirm returns is pending, refused or not', async () => {
    let settle: (ok: boolean) => void = () => undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = (ok) => {
            if (ok) resolve();
            else reject(new Error('refused'));
          };
        }),
    );
    render(<Confirm tone="danger" onConfirm={onConfirm} onCancel={() => undefined} />);
    const confirm = screen.getByRole('button', { name: 'Close order' });
    fireEvent.click(confirm);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle(false);
      await Promise.resolve();
    });
    expect(confirm.hasAttribute('aria-busy')).toBe(false);
  });

  it('refuses a label that is not the verb of the title', () => {
    expect(confirmLabelProblem('Close order PO-1?', 'Close order')).toBeUndefined();
    expect(confirmLabelProblem('Disable user ops1?', 'disable user')).toBeUndefined();
    expect(confirmLabelProblem('Close order PO-1?', 'OK')).toMatch(/not a verb/);
    expect(confirmLabelProblem('Close order PO-1?', 'Yes')).toMatch(/not a verb/);
    expect(confirmLabelProblem('Close order PO-1?', ' ')).toMatch(/not a verb/);
    expect(confirmLabelProblem('Close order PO-1?', 'Cancel order')).toMatch(/repeat the title/);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        <ConfirmDialog
          open
          title="Close order PO-1?"
          body="x"
          confirmLabel="OK"
          onConfirm={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    ).toThrow(/not a verb/);
    spy.mockRestore();
  });

  it('confirmed: the owner closes it and onCancel is never called (#352 H1)', async () => {
    const onCancel = vi.fn();
    function Owner() {
      const [open, setOpen] = useState(true);
      const [pending, setPending] = useState(false);
      return (
        <ConfirmDialog
          open={open}
          title="Close order PO-2610-303?"
          body="A closed order cannot be opened again."
          confirmLabel="Close order"
          tone="danger"
          pending={pending}
          onConfirm={async () => {
            setPending(true);
            await Promise.resolve();
            setPending(false);
            setOpen(false);
          }}
          onCancel={onCancel}
          testId="confirm"
        />
      );
    }
    render(<Owner />);
    fireEvent.click(screen.getByRole('button', { name: 'Close order' }));
    await flushOverlayEvents();
    await flushOverlayEvents();
    expect(screen.getByTestId<HTMLDialogElement>('confirm').open).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('opens again when the browser closes it while a write is busy (#352 M3)', async () => {
    const onCancel = vi.fn();
    render(<Confirm tone="danger" pending onConfirm={() => undefined} onCancel={onCancel} />);
    const dialog = screen.getByTestId<HTMLDialogElement>('confirm');
    // Chrome's close watcher on a repeated Escape: a cancel nobody can refuse, then the close.
    act(() => {
      dialog.dispatchEvent(new Event('cancel'));
      dialog.close();
    });
    expect(dialog.open).toBe(false);
    await flushOverlayEvents();
    expect(dialog.open).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });
});
