import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { Icon, type IconName } from './icons.tsx';
import type { Tone } from '../../domain/tones.ts';

/**
 * The one badge (UX-1c, #315; design system 4.2): every status in the app is a word in a small
 * frame, coloured by one of the six tones (2.3). Colour never stands alone: the word is always
 * there, and a glyph (`icon`, `aria-hidden`) may go before it. Domain badges (`StateBadge`,
 * `PriorityBadge`, `OrderStatusBadge` …) keep their names and `data-*` attributes and draw
 * themselves through `BadgeFrame` with this shape.
 */

export type BadgeVariant = 'soft' | 'solid' | 'outline' | 'dashed';
export type BadgeSize = 'sm' | 'md' | 'lg';

/**
 * 18 / 22 / 28 px high (as a minimum: text spacing overrides may grow it), `text-xs` 600, 13 px
 * at `md`, 2 × 6 px padding. Every variant has a 1 px border so soft and outline badges line up.
 */
const SIZE: Readonly<Record<BadgeSize, string>> = {
  sm: 'min-h-4.5 gap-0.5 px-1.5 text-xs',
  md: 'min-h-5.5 gap-1 px-1.5 text-[0.8125rem] leading-4',
  lg: 'min-h-7 gap-1 px-2 text-sm',
};

/** The glyph's size per badge size (12 px in a badge, design system 2.4). */
const ICON_SIZE = { sm: 12, md: 12, lg: 16 } as const;

/** Written out in full: Tailwind finds class names in the source, never built at run time. */
export const TONE_CLASS: Readonly<Record<Tone, Readonly<Record<BadgeVariant, string>>>> = {
  neutral: {
    soft: 'bg-neutral-soft text-neutral-ink border-neutral-border',
    solid: 'bg-neutral-solid text-neutral-on-solid border-neutral-solid',
    outline: 'bg-surface text-neutral-ink border-neutral-border',
    dashed: 'bg-surface text-neutral-ink border-neutral-border border-dashed',
  },
  info: {
    soft: 'bg-info-soft text-info-ink border-info-border',
    solid: 'bg-info-solid text-info-on-solid border-info-solid',
    outline: 'bg-surface text-info-ink border-info-border',
    dashed: 'bg-surface text-info-ink border-info-border border-dashed',
  },
  ok: {
    soft: 'bg-ok-soft text-ok-ink border-ok-border',
    solid: 'bg-ok-solid text-ok-on-solid border-ok-solid',
    outline: 'bg-surface text-ok-ink border-ok-border',
    dashed: 'bg-surface text-ok-ink border-ok-border border-dashed',
  },
  warn: {
    soft: 'bg-warn-soft text-warn-ink border-warn-border',
    // The light solid fills keep a border in their tone's border colour (2.4).
    solid: 'bg-warn-solid text-warn-on-solid border-warn-border',
    outline: 'bg-surface text-warn-ink border-warn-border',
    dashed: 'bg-surface text-warn-ink border-warn-border border-dashed',
  },
  caution: {
    soft: 'bg-caution-soft text-caution-ink border-caution-border',
    solid: 'bg-caution-solid text-caution-on-solid border-caution-border',
    outline: 'bg-surface text-caution-ink border-caution-border',
    dashed: 'bg-surface text-caution-ink border-caution-border border-dashed',
  },
  alarm: {
    soft: 'bg-alarm-soft text-alarm-ink border-alarm-border',
    solid: 'bg-alarm-solid text-alarm-on-solid border-alarm-solid',
    outline: 'bg-surface text-alarm-ink border-alarm-border',
    dashed: 'bg-surface text-alarm-ink border-alarm-border border-dashed',
  },
};

/** The badge's shape without its colours, for a frame that is not a `<span>` (a list item). */
export function badgeShape(size: BadgeSize = 'sm'): string {
  return `inline-flex items-center whitespace-nowrap rounded-sm border font-semibold ${SIZE[size]}`;
}

/** `data-*` attributes pass through, so a domain badge keeps the ones its tests read. */
export type DataAttributes = Readonly<Record<`data-${string}`, string | undefined>>;

export interface BadgeFrameProps
  extends
    Omit<HTMLAttributes<HTMLSpanElement>, 'color' | 'children' | 'className'>,
    DataAttributes {
  /** Fill, text and border colour classes (token utilities only). */
  readonly colors: string;
  readonly size?: BadgeSize;
  readonly icon?: IconName | undefined;
  /** Tooltip, also the accessible description: a supplement, never the only place of a fact. */
  readonly title?: string | undefined;
  /**
   * For layout and the few text decorations a status needs (`line-through`); never colours,
   * sizes or padding: those come from the props, so nothing competes with the badge's own classes.
   */
  readonly className?: string | undefined;
  readonly ref?: Ref<HTMLSpanElement>;
  readonly children: ReactNode;
}

/**
 * A badge with colours given by the caller: the machine-state and priority badges use it. Every
 * other attribute (`id`, `aria-*`, `data-*`, a ref) passes through to the `<span>`.
 */
export function BadgeFrame({
  colors,
  size = 'sm',
  icon,
  title,
  className,
  children,
  ...rest
}: BadgeFrameProps) {
  return (
    <span
      {...rest}
      {...(title === undefined ? {} : { title })}
      className={[badgeShape(size), colors, className].filter(Boolean).join(' ')}
    >
      {icon ? <Icon name={icon} size={ICON_SIZE[size]} /> : null}
      {children}
    </span>
  );
}

export interface BadgeProps extends Omit<BadgeFrameProps, 'colors'> {
  readonly tone: Tone;
  readonly variant?: BadgeVariant;
}

/** A status word in one of the six tones: `<Badge tone="alarm">Open</Badge>`. */
export function Badge({ tone, variant = 'soft', ...rest }: BadgeProps) {
  return <BadgeFrame colors={TONE_CLASS[tone][variant]} {...rest} />;
}
