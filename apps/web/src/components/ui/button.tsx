import type { ButtonHTMLAttributes, Ref } from 'react';
import { Icon, type IconName } from './icons.tsx';

/**
 * The one button (UX-1c, #315; design system 4.1). `primary` for the one main action of a page,
 * form or dialog; `secondary` for every other action; `ghost` for low-weight actions in tables
 * and toolbars; `danger` for irreversible ones (`dangerSolid` is the solid form a confirm dialog
 * uses). Disabled looks the same for every variant and never by opacity (G-10); loading keeps the
 * label, shows a spinner, sets `aria-busy` and disables the button.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSolid';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'touch';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Shows a spinner in place of the icon, sets `aria-busy`, disables; the label stays. */
  readonly loading?: boolean;
  /** A leading icon, `aria-hidden`. */
  readonly icon?: IconName;
  readonly fullWidth?: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
}

interface InnerButtonProps extends ButtonProps {
  readonly iconOnly?: boolean;
}

/** Height (a minimum: text spacing overrides may grow it) and text size (design system 4.1). */
const SIZE: Readonly<Record<ButtonSize, string>> = {
  sm: 'min-h-7 gap-1.5 text-[0.8125rem]',
  md: 'min-h-9 gap-2 text-sm',
  lg: 'min-h-11 gap-2 text-base',
  touch: 'min-h-14 gap-2.5 text-lg',
};

/** Side padding with a label; an icon-only button is square instead (24 px minimum target). */
const PADDING: Readonly<Record<ButtonSize, string>> = {
  sm: 'px-2.5',
  md: 'px-3.5',
  lg: 'px-4.5',
  touch: 'px-5',
};
const SQUARE: Readonly<Record<ButtonSize, string>> = {
  sm: 'min-w-7',
  md: 'min-w-9',
  lg: 'min-w-11',
  touch: 'min-w-14',
};

const ICON_SIZE = { sm: 16, md: 16, lg: 20, touch: 24 } as const;
/** The spinner is 14 px on the small buttons (design system 4.1). */
const SPINNER: Readonly<Record<ButtonSize, string>> = {
  sm: 'size-3.5',
  md: 'size-3.5',
  lg: '',
  touch: '',
};

/**
 * Rest and hover per variant; hover only while enabled (`enabled:`), so a disabled button has
 * none. The disabled look (`disabled:`) is one for all: fill `disabled`, border `disabled-line`,
 * text `disabled-ink` (6.92:1).
 */
const VARIANT: Readonly<Record<ButtonVariant, string>> = {
  primary:
    'border-accent bg-accent text-on-accent enabled:hover:border-accent-hover enabled:hover:bg-accent-hover',
  secondary: 'border-line-strong bg-surface text-ink enabled:hover:bg-surface-hover',
  ghost: 'border-transparent bg-transparent text-accent enabled:hover:bg-surface-hover',
  danger: 'border-alarm-border bg-surface text-alarm-ink enabled:hover:bg-alarm-soft',
  dangerSolid:
    'border-alarm-solid bg-alarm-solid text-alarm-on-solid enabled:hover:border-alarm-ink enabled:hover:bg-alarm-ink',
};

const DISABLED =
  'disabled:cursor-not-allowed disabled:border-disabled-line disabled:bg-disabled disabled:text-disabled-ink';

export function buttonClass({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  iconOnly = false,
}: {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly fullWidth?: boolean;
  readonly iconOnly?: boolean;
} = {}): string {
  return [
    'inline-flex items-center justify-center whitespace-nowrap rounded-md border font-medium',
    'motion-safe:transition-colors motion-safe:duration-fast',
    variant === 'primary' || variant === 'dangerSolid' ? 'font-semibold' : '',
    SIZE[size],
    iconOnly ? SQUARE[size] : PADDING[size],
    VARIANT[variant],
    DISABLED,
    fullWidth ? 'w-full' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The loading indicator: a turning arc; under `prefers-reduced-motion` a still ellipsis instead
 * (design system 4.1). Decorative: `aria-busy` on the button says it is busy.
 */
function Spinner({ size }: { readonly size: ButtonSize }) {
  return (
    <>
      <span className="hidden motion-safe:inline-flex" data-spinner="">
        <Icon name="spinner" size={ICON_SIZE[size]} className={`animate-spin ${SPINNER[size]}`} />
      </span>
      <span aria-hidden="true" className="motion-safe:hidden" data-spinner="">
        …
      </span>
    </>
  );
}

function ButtonBase({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  fullWidth = false,
  iconOnly = false,
  type = 'button',
  disabled,
  className,
  children,
  ...rest
}: InnerButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      disabled={disabled === true || loading}
      {...(loading ? { 'aria-busy': true } : {})}
      className={`${buttonClass({ variant, size, fullWidth, iconOnly })}${className ? ` ${className}` : ''}`}
    >
      {loading ? (
        <Spinner size={size} />
      ) : icon ? (
        <Icon name={icon} size={ICON_SIZE[size]} />
      ) : null}
      {children}
    </button>
  );
}

export function Button(props: ButtonProps) {
  return <ButtonBase {...props} />;
}

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children' | 'fullWidth'> {
  readonly icon: IconName;
  /** Required: the accessible name and the tooltip. */
  readonly label: string;
}

/** A button that shows only an icon; `label` is its accessible name and its tooltip. */
export function IconButton({ icon, label, ...rest }: IconButtonProps) {
  return <ButtonBase {...rest} icon={icon} aria-label={label} title={label} iconOnly />;
}
