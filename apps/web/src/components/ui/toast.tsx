import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, IconButton } from './button.tsx';
import { CARD_TONE_BAR } from './card.tsx';
import { Icon, type IconName } from './icons.tsx';

/**
 * Toasts (UX-1e, #317; design system 4.10): a short confirmation of a completed write that leaves
 * the screen ("Coding saved"). A write whose result the screen shows anyway needs none, and a
 * toast never replaces an inline message a test reads (`coding-message`, `action-message` …).
 *
 * `toast({...})` from anywhere; `ToastRegion`, mounted once by the app, shows them bottom right
 * (top, full width below `md`, off the idle warning's bottom strip), at most three, the oldest
 * timed one leaving first. Neutral and ok toasts go after 6 s, paused while the pointer is over
 * the region or the focus is in it; alarm toasts stay until dismissed. A polite live region
 * announces neutral and ok toasts, an assertive one alarm toasts (the live behaviour of
 * `role="status"` and `role="alert"`), each a visually hidden copy of the title and body, so the
 * buttons are not read out. Both are in the page from the start, so a toast added to them is
 * announced; they carry `aria-live` rather than the roles, so an empty region adds no status or
 * alert to every page (a screen's own `role="alert"` stays the only one).
 */
export type ToastTone = 'neutral' | 'ok' | 'alarm';

export interface ToastOptions {
  readonly tone: ToastTone;
  readonly title: string;
  readonly body?: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}

export interface Toast extends ToastOptions {
  readonly id: number;
}

export const TOAST_LIMIT = 3;
export const TOAST_MS = 6_000;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: readonly Toast[]): void {
  toasts = next;
  for (const listener of listeners) listener();
}

/** Shows a toast; returns its id, for `dismissToast`. */
export function toast(options: ToastOptions): number {
  const id = nextId;
  nextId += 1;
  const next = [...toasts, { ...options, id }];
  // Over the limit the oldest timed toast leaves first: an alarm stays until dismissed.
  while (next.length > TOAST_LIMIT) {
    const timed = next.findIndex((t) => t.tone !== 'alarm');
    next.splice(timed >= 0 ? timed : 0, 1);
  }
  publish(next);
  return id;
}

export function dismissToast(id: number): void {
  if (toasts.some((t) => t.id === id)) publish(toasts.filter((t) => t.id !== id));
}

/** Empties the list (tests). */
export function clearToasts(): void {
  publish([]);
}

function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => toasts,
  );
}

const GLYPH: Readonly<Record<ToastTone, IconName>> = {
  neutral: 'info',
  ok: 'check',
  alarm: 'alert',
};

const GLYPH_COLOUR: Readonly<Record<ToastTone, string>> = {
  neutral: 'text-ink-secondary',
  ok: 'text-ok-ink',
  alarm: 'text-alarm-ink',
};

/** One toast; a timed one counts down only while not paused, and resumes where it stopped. */
function ToastCard({
  item,
  paused,
  onDismissed,
}: {
  readonly item: Toast;
  readonly paused: boolean;
  /** After a button removed it: the region checks where the focus went. */
  readonly onDismissed: () => void;
}) {
  const timed = item.tone !== 'alarm';
  const [left, setLeft] = useState(TOAST_MS);
  useEffect(() => {
    if (!timed || paused) return undefined;
    const started = Date.now();
    const timer = setTimeout(() => {
      dismissToast(item.id);
    }, left);
    return () => {
      clearTimeout(timer);
      setLeft((was) => Math.max(0, was - (Date.now() - started)));
    };
    // `left` is read when the countdown starts or resumes, not on every change it makes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timed, paused, item.id]);
  return (
    <div
      data-testid={`toast-${String(item.id)}`}
      data-tone={item.tone}
      className={[
        'pointer-events-auto flex gap-2 rounded-lg border border-line bg-surface p-3 text-sm text-ink shadow-elevation-2',
        'motion-safe:transition-[opacity,translate] motion-safe:duration-base motion-safe:ease-standard',
        'starting:translate-y-2 starting:opacity-0',
        item.tone === 'neutral' ? '' : CARD_TONE_BAR[item.tone],
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Icon name={GLYPH[item.tone]} size={16} className={`mt-0.5 ${GLYPH_COLOUR[item.tone]}`} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{item.title}</p>
        {item.body === undefined ? null : <p className="mt-0.5 text-ink-secondary">{item.body}</p>}
        {item.action === undefined ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2.5 mt-1"
            onClick={() => {
              item.action?.onClick();
              dismissToast(item.id);
              onDismissed();
            }}
          >
            {item.action.label}
          </Button>
        )}
      </div>
      <IconButton
        icon="close"
        label="Dismiss"
        variant="ghost"
        size="sm"
        className="-my-1 -mr-1"
        onClick={() => {
          dismissToast(item.id);
          onDismissed();
        }}
      />
    </div>
  );
}

/** What a live region reads for a toast: its title and body, not its buttons (#352 review L5). */
function announcement(item: Toast): string {
  return item.body === undefined ? item.title : `${item.title}. ${item.body}`;
}

export function ToastRegion() {
  const items = useToasts();
  const region = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  // A removed button fires no reliable `blur`: once it is gone, the focus is looked up (L4).
  const onDismissed = () => {
    setTimeout(() => {
      setFocused(region.current?.contains(document.activeElement) ?? false);
    }, 0);
  };
  const said = (alarm: boolean) =>
    items
      .filter((item) => (item.tone === 'alarm') === alarm)
      .map((item) => <p key={item.id}>{announcement(item)}</p>);
  return (
    <div
      ref={region}
      data-testid="toast-region"
      data-paused={paused}
      className="pointer-events-none fixed inset-x-4 top-4 z-toast flex flex-col gap-2 md:top-auto md:bottom-4 md:left-auto md:w-96 print:hidden"
      onPointerEnter={() => {
        setHovered(true);
      }}
      onPointerLeave={() => {
        setHovered(false);
      }}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      {items.map((item) => (
        <ToastCard key={item.id} item={item} paused={paused} onDismissed={onDismissed} />
      ))}
      <div aria-live="assertive" className="sr-only">
        {said(true)}
      </div>
      <div aria-live="polite" className="sr-only">
        {said(false)}
      </div>
    </div>
  );
}
