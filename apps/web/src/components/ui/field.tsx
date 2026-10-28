import { useId, type ReactNode } from 'react';
import { Icon } from './icons.tsx';

/**
 * Form fields (UX-1d2, #319; design system 4.7): one label, hint and error layout for every
 * control, and the control look. `Field` renders the visible `<label>`, the hint below the control
 * and the error below the hint, and hands the control its `id`, its `aria-describedby` (hint and
 * error) and whether it is invalid. The error has no role: the form's summary (a refused write's
 * `FailureMessage`, or the form's own alert) announces, the field shows where (WCAG 3.3.1).
 */

export type ControlSize = 'md' | 'touch';
/**
 * A text control's size: `ControlSize`, plus `lg` (44 px, 16 px text) for the login and account
 * forms (design system 2.7 and 4.7), whose 16 px text also keeps iOS Safari from zooming in on focus.
 */
export type TextControlSize = ControlSize | 'lg';

export interface FieldIds {
  /** The control's `id`, which the `<label>` names. */
  readonly id: string;
  /** The hint's and the error's ids, for the control's `aria-describedby`; undefined if none. */
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}

export interface FieldFrameProps {
  /** The visible label; the control's accessible name. */
  readonly label: ReactNode;
  /** Below the control, tied to it by `aria-describedby`. */
  readonly hint?: ReactNode | undefined;
  /** Below the hint in `alarm-ink`; sets `aria-invalid` and joins `aria-describedby`. */
  readonly error?: string | undefined;
  /** Adds " (required)" to the label; an optional field says nothing. */
  readonly required?: boolean | undefined;
  /**
   * The label left of the control, as in a filter bar; `'sm'` from 640 px only, above the control
   * on a phone, so a long option (the shift picker's) keeps the row's whole width (#339).
   */
  readonly inline?: boolean | 'sm' | undefined;
  /** The control's id; a generated one when not given. */
  readonly id?: string | undefined;
  /** Extra ids for `aria-describedby` after the hint and the error (a character count). */
  readonly describedBy?: string | undefined;
  /** Ids read before the hint and the error (a number's unit: "12, min, …"). */
  readonly describedByFirst?: string | undefined;
  /** Layout classes for the field's frame (width, margins). */
  readonly className?: string | undefined;
}

export interface FieldProps extends FieldFrameProps {
  readonly children: (ids: FieldIds) => ReactNode;
}

/** The ids of a field's parts, from its control id. */
export function fieldIds(
  id: string,
  {
    hint,
    error,
    describedBy,
    describedByFirst,
  }: Pick<FieldFrameProps, 'hint' | 'error' | 'describedBy' | 'describedByFirst'>,
): FieldIds & { readonly hintId: string; readonly errorId: string } {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = error !== undefined && error !== '';
  const ids = [
    describedByFirst,
    hint === undefined || hint === null ? undefined : hintId,
    invalid ? errorId : undefined,
    describedBy,
  ].filter((part): part is string => part !== undefined && part !== '');
  return {
    id,
    hintId,
    errorId,
    invalid,
    describedBy: ids.length === 0 ? undefined : ids.join(' '),
  };
}

/**
 * A label's words with " (required)" when it is. Plain text in one run: a styled span would read
 * the same in a browser, but some accessible-name engines drop the space before it.
 */
export function LabelText({
  children,
  required,
}: {
  readonly children: ReactNode;
  readonly required?: boolean | undefined;
}) {
  return (
    <>
      {children}
      {required ? ' (required)' : null}
    </>
  );
}

/** A field's hint: 12 px `ink-secondary`. */
export function FieldHint({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-ink-secondary">
      {children}
    </p>
  );
}

/** A field's error: `alarm-ink` with the alert glyph, no role (the form's summary announces). */
export function FieldError({
  id,
  children,
}: {
  readonly id: string;
  readonly children: ReactNode;
}) {
  return (
    <p id={id} className="flex items-start gap-1 text-xs font-medium text-alarm-ink">
      <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

const INLINE_ROW = {
  true: 'flex min-w-0 items-center gap-2',
  sm: 'flex min-w-0 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2',
  false: 'contents',
} as const;

export function Field({
  label,
  hint,
  error,
  required = false,
  inline = false,
  id: givenId,
  describedBy,
  describedByFirst,
  className,
  children,
}: FieldProps) {
  const generated = useId();
  const ids = fieldIds(givenId ?? generated, { hint, error, describedBy, describedByFirst });
  return (
    <div className={`flex max-w-full min-w-0 flex-col gap-1${className ? ` ${className}` : ''}`}>
      <div className={INLINE_ROW[String(inline) as keyof typeof INLINE_ROW]}>
        <label
          htmlFor={ids.id}
          className={`text-sm font-medium text-ink${inline === false ? '' : ' whitespace-nowrap'}`}
        >
          <LabelText required={required}>{label}</LabelText>
        </label>
        {children({ id: ids.id, describedBy: ids.describedBy, invalid: ids.invalid })}
      </div>
      {hint === undefined || hint === null ? null : <FieldHint id={ids.hintId}>{hint}</FieldHint>}
      {ids.invalid ? <FieldError id={ids.errorId}>{error}</FieldError> : null}
    </div>
  );
}

/** Height and text per size (a minimum: text spacing overrides may grow it). */
const CONTROL_SIZE: Readonly<Record<TextControlSize, string>> = {
  md: 'min-h-9 px-2.5 py-1.5 text-sm',
  lg: 'min-h-11 px-3 py-2 text-base',
  touch: 'min-h-14 px-4 py-3 text-lg',
};

/**
 * The look of a text control (`input`, `textarea`, `select`): white, a 1 px `line-strong` border
 * (4.76:1), `radius-md`, the focus ring from the base style; invalid (`aria-invalid`) an
 * `alarm-border` border; disabled as a disabled button (`disabled`, `disabled-line`,
 * `disabled-ink`), never opacity. Layout (width) is the caller's.
 */
export function controlClass({ size = 'md' }: { readonly size?: TextControlSize } = {}): string {
  return [
    'rounded-md border border-line-strong bg-surface text-ink placeholder:text-ink-secondary',
    'aria-invalid:border-alarm-border',
    'disabled:cursor-not-allowed disabled:border-disabled-line disabled:bg-disabled disabled:text-disabled-ink',
    CONTROL_SIZE[size],
  ].join(' ');
}

/**
 * "12 of 500 characters" under a text box, tied to it by `aria-describedby` (its `id`); over the
 * limit it turns `alarm-ink` and says by how many.
 */
export function CharacterCount({
  id,
  length,
  max,
}: {
  readonly id: string;
  readonly length: number;
  readonly max: number;
}) {
  const over = length - max;
  return (
    <span
      id={id}
      data-over={over > 0 ? 'true' : undefined}
      className={`text-xs ${over > 0 ? 'font-medium text-alarm-ink' : 'text-ink-secondary'}`}
    >
      {length} of {max} characters
      {over > 0 ? ` (${String(over)} too many)` : null}
    </span>
  );
}
