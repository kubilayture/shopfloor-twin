import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import {
  CharacterCount,
  controlClass,
  Field,
  FieldError,
  FieldHint,
  fieldIds,
  LabelText,
  type ControlSize,
  type FieldFrameProps,
} from './field.tsx';
import { Icon } from './icons.tsx';

/**
 * The form controls (UX-1d2, #319; design system 4.7), each inside its `Field`: `TextInput`,
 * `Textarea` (with its `CharacterCount`), `Select` (the native `<select>`, never a custom
 * listbox), `NumberInput` (a decimal text box with its unit), `Checkbox` and `Radio` (16 px in a
 * 24 px hit area, label to the right), and `ChoiceGroup` / `RadioGroup` (a `fieldset` with its
 * `legend`). Every control takes a `name` and gets an `id` (G-23); `className` sets the control's
 * width, `fieldClassName` the frame's layout; `data-*` and the native attributes pass through.
 */

interface ControlFieldProps extends Omit<FieldFrameProps, 'className'> {
  /** Required: every control has a name (G-23), so autofill and the browser's audits know it. */
  readonly name: string;
  readonly size?: ControlSize | undefined;
  /** Layout classes for the field's frame. */
  readonly fieldClassName?: string | undefined;
}

/** Native attributes the field sets itself. */
type Managed = 'id' | 'name' | 'size' | 'required' | 'aria-describedby' | 'aria-invalid';

export interface TextInputProps
  extends ControlFieldProps, Omit<InputHTMLAttributes<HTMLInputElement>, Managed | 'children'> {
  readonly ref?: Ref<HTMLInputElement> | undefined;
}

const join = (...parts: (string | undefined | false)[]): string => parts.filter(Boolean).join(' ');

export function TextInput({
  label,
  hint,
  error,
  required,
  inline,
  id,
  describedBy,
  name,
  size = 'md',
  fieldClassName,
  className,
  type = 'text',
  ...rest
}: TextInputProps) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      inline={inline}
      id={id}
      describedBy={describedBy}
      className={fieldClassName}
    >
      {(ids) => (
        <input
          {...rest}
          type={type}
          id={ids.id}
          name={name}
          aria-describedby={ids.describedBy}
          aria-invalid={ids.invalid || undefined}
          className={join(controlClass({ size }), className)}
        />
      )}
    </Field>
  );
}

export interface TextareaProps
  extends
    ControlFieldProps,
    Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, Managed | 'children' | 'value'> {
  readonly value: string;
  /** The most characters: sets `maxLength` and shows the `CharacterCount` under the box. */
  readonly max?: number | undefined;
  readonly ref?: Ref<HTMLTextAreaElement> | undefined;
}

export function Textarea({
  label,
  hint,
  error,
  required,
  inline,
  id: givenId,
  describedBy,
  name,
  size = 'md',
  fieldClassName,
  className,
  max,
  rows = 3,
  value,
  ...rest
}: TextareaProps) {
  const generated = useId();
  const id = givenId ?? generated;
  const countId = `${id}-count`;
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      inline={inline}
      id={id}
      describedBy={join(max === undefined ? undefined : countId, describedBy) || undefined}
      className={fieldClassName}
    >
      {(ids) => (
        <>
          <textarea
            {...rest}
            id={ids.id}
            name={name}
            value={value}
            rows={rows}
            maxLength={max}
            aria-describedby={ids.describedBy}
            aria-invalid={ids.invalid || undefined}
            className={join(controlClass({ size }), 'w-full', className)}
          />
          {max === undefined ? null : (
            <CharacterCount id={countId} length={value.length} max={max} />
          )}
        </>
      )}
    </Field>
  );
}

export interface SelectProps
  extends ControlFieldProps, Omit<SelectHTMLAttributes<HTMLSelectElement>, Managed> {
  /** The `<option>` (and `<optgroup>`) elements. */
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLSelectElement> | undefined;
}

/**
 * The native `<select>` on the tokens with the chevron from `icons.tsx` (H-05: as wide as its
 * longest option up to the field's width; shorten option texts at the source). The e2e specs drive
 * it with `selectOption`.
 */
export function Select({
  label,
  hint,
  error,
  required,
  inline,
  id,
  describedBy,
  name,
  size = 'md',
  fieldClassName,
  className,
  children,
  ...rest
}: SelectProps) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      inline={inline}
      id={id}
      describedBy={describedBy}
      className={fieldClassName}
    >
      {(ids) => (
        <SelectControl
          {...rest}
          id={ids.id}
          name={name}
          size={size}
          describedBy={ids.describedBy}
          invalid={ids.invalid}
          className={className}
        >
          {children}
        </SelectControl>
      )}
    </Field>
  );
}

/** The bare styled `<select>` with its chevron, for a field that lays out its own label. */
export function SelectControl({
  id,
  name,
  size = 'md',
  describedBy,
  invalid = false,
  className,
  children,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, Managed> & {
  readonly id: string;
  readonly name: string;
  readonly size?: ControlSize | undefined;
  readonly describedBy?: string | undefined;
  readonly invalid?: boolean | undefined;
  readonly ref?: Ref<HTMLSelectElement> | undefined;
}) {
  return (
    <span className={join('relative inline-flex max-w-full min-w-0', className)}>
      <select
        {...rest}
        id={id}
        name={name}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className={join(
          controlClass({ size }),
          'w-full min-w-0 cursor-pointer appearance-none disabled:cursor-not-allowed',
          size === 'touch' ? 'pr-11' : 'pr-8',
        )}
      >
        {children}
      </select>
      <Icon
        name="chevron-down"
        size={size === 'touch' ? 20 : 16}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-secondary"
      />
    </span>
  );
}

export interface NumberInputProps extends TextInputProps {
  /** The unit after the box ("min", "Pa/min"): read with the field (in `aria-describedby`). */
  readonly unit?: string | undefined;
}

/**
 * A number as text (`inputMode="decimal"`: no spinner, no locale-dependent parsing by the
 * browser), in tabular figures, with its unit after the box. The caller parses the text.
 */
export function NumberInput({
  label,
  hint,
  error,
  required,
  inline,
  id: givenId,
  describedBy,
  name,
  size = 'md',
  fieldClassName,
  className,
  unit,
  ...rest
}: NumberInputProps) {
  const generated = useId();
  const id = givenId ?? generated;
  const unitId = `${id}-unit`;
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      inline={inline}
      id={id}
      describedByFirst={unit === undefined ? undefined : unitId}
      describedBy={describedBy}
      className={fieldClassName}
    >
      {(ids) => (
        <span className="inline-flex max-w-full items-stretch">
          <input
            inputMode="decimal"
            autoComplete="off"
            {...rest}
            type="text"
            id={ids.id}
            name={name}
            aria-describedby={ids.describedBy}
            aria-invalid={ids.invalid || undefined}
            className={join(
              controlClass({ size }),
              'min-w-0 tabular-nums',
              unit === undefined ? undefined : 'rounded-r-none',
              className ?? 'w-28',
            )}
          />
          {unit === undefined ? null : (
            <span
              id={unitId}
              className="inline-flex items-center rounded-r-md border border-l-0 border-line-strong bg-surface-sunken px-2.5 text-sm text-ink-secondary"
            >
              {unit}
            </span>
          )}
        </span>
      )}
    </Field>
  );
}

export interface CheckProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  Managed | 'type' | 'children'
> {
  readonly label: ReactNode;
  readonly name: string;
  readonly hint?: ReactNode | undefined;
  readonly error?: string | undefined;
  /** Marks it invalid without an error of its own (its group's error says why). */
  readonly invalid?: boolean | undefined;
  readonly id?: string | undefined;
  readonly size?: ControlSize | undefined;
  readonly ref?: Ref<HTMLInputElement> | undefined;
}

/** A 16 px box (24 px in the terminal) in a 24 px hit area (44 px in the terminal) that is the label. */
const CHECK_HIT: Readonly<Record<ControlSize, string>> = {
  md: 'min-h-6 text-sm',
  touch: 'min-h-14 text-lg',
};
const CHECK_BOX: Readonly<Record<ControlSize, string>> = {
  md: 'size-6',
  touch: 'size-11',
};
/** The hint and error start under the label text: the box plus its 4 px gap. */
const CHECK_INDENT: Readonly<Record<ControlSize, string>> = {
  md: 'pl-7',
  touch: 'pl-12',
};
const CHECK_INPUT: Readonly<Record<ControlSize, string>> = {
  md: 'size-4',
  touch: 'size-6',
};

function Check({
  type,
  label,
  name,
  hint,
  error,
  invalid = false,
  id: givenId,
  size = 'md',
  className,
  ...rest
}: CheckProps & { readonly type: 'checkbox' | 'radio' }) {
  const generated = useId();
  const ids = fieldIds(givenId ?? generated, { hint, error });
  return (
    <div className={join('flex flex-col gap-0.5', className)}>
      <label
        htmlFor={ids.id}
        className={join(
          'inline-flex cursor-pointer items-center text-ink has-disabled:cursor-not-allowed has-disabled:text-disabled-ink',
          CHECK_HIT[size],
        )}
      >
        <span className={join('inline-flex shrink-0 items-center justify-center', CHECK_BOX[size])}>
          <input
            {...rest}
            type={type}
            id={ids.id}
            name={name}
            aria-describedby={ids.describedBy}
            aria-invalid={ids.invalid || invalid || undefined}
            className={join(
              'cursor-pointer accent-accent disabled:cursor-not-allowed',
              CHECK_INPUT[size],
            )}
          />
        </span>
        <span className="pl-1">{label}</span>
      </label>
      {hint === undefined || hint === null ? null : (
        <div className={CHECK_INDENT[size]}>
          <FieldHint id={ids.hintId}>{hint}</FieldHint>
        </div>
      )}
      {ids.invalid ? (
        <div className={CHECK_INDENT[size]}>
          <FieldError id={ids.errorId}>{error}</FieldError>
        </div>
      ) : null}
    </div>
  );
}

export function Checkbox(props: CheckProps) {
  return <Check {...props} type="checkbox" />;
}

export function Radio(props: CheckProps) {
  return <Check {...props} type="radio" />;
}

export interface ChoiceGroupProps {
  /** The `legend`: the group's name. */
  readonly legend: ReactNode;
  readonly hint?: ReactNode | undefined;
  readonly error?: string | undefined;
  /** Adds " (required)" to the legend. */
  readonly required?: boolean | undefined;
  /** The choices side by side, wrapping, instead of one per line. */
  readonly inline?: boolean | undefined;
  readonly className?: string | undefined;
  /** The `Checkbox` or `Radio` elements. */
  readonly children: ReactNode;
}

/**
 * A group of checkboxes or radios (design system 7, 1.3.1): a `fieldset` named by its `legend`,
 * described by the hint and the error.
 */
export function ChoiceGroup({
  legend,
  hint,
  error,
  required,
  inline = false,
  className,
  children,
}: ChoiceGroupProps) {
  const ids = fieldIds(useId(), { hint, error });
  return (
    <fieldset
      aria-describedby={ids.describedBy}
      className={join('flex min-w-0 flex-col gap-1', className)}
    >
      <legend className="mb-1 text-sm font-medium text-ink">
        <LabelText required={required}>{legend}</LabelText>
      </legend>
      <div className={inline ? 'flex flex-wrap gap-x-4 gap-y-1' : 'flex flex-col gap-0.5'}>
        {children}
      </div>
      {hint === undefined || hint === null ? null : <FieldHint id={ids.hintId}>{hint}</FieldHint>}
      {ids.invalid ? <FieldError id={ids.errorId}>{error}</FieldError> : null}
    </fieldset>
  );
}

export interface RadioGroupProps<Value extends string> extends Omit<ChoiceGroupProps, 'children'> {
  readonly name: string;
  readonly options: readonly {
    readonly value: Value;
    readonly label: ReactNode;
    readonly hint?: ReactNode | undefined;
    readonly disabled?: boolean | undefined;
    readonly testId?: string | undefined;
  }[];
  readonly value: Value | undefined;
  readonly onChange: (value: Value) => void;
  readonly disabled?: boolean | undefined;
  readonly size?: ControlSize | undefined;
}

/** One choice of a few, all visible: radios in a `fieldset`, the same `name`. */
export function RadioGroup<Value extends string>({
  name,
  options,
  value,
  onChange,
  disabled = false,
  size,
  error,
  ...group
}: RadioGroupProps<Value>) {
  const invalid = error !== undefined && error !== '';
  return (
    <ChoiceGroup {...group} error={error}>
      {options.map((option) => (
        <Radio
          key={option.value}
          name={name}
          value={option.value}
          label={option.label}
          hint={option.hint}
          size={size}
          checked={value === option.value}
          disabled={disabled || option.disabled}
          data-testid={option.testId}
          invalid={invalid}
          onChange={() => {
            onChange(option.value);
          }}
        />
      ))}
    </ChoiceGroup>
  );
}
