import type { ReactNode } from 'react';

/**
 * The in-house icon set (UX-1a, #314; design system 4.13): inline SVG on a 20 × 20 grid, drawn
 * for 16 and 20 px (12 px in a badge), in `currentColor` so an icon takes its text's colour and
 * follows the theme. No icon package. An icon is always decorative (`aria-hidden`): the word or
 * the accessible name beside it carries the meaning.
 *
 * Line icons are strokes 1.75 units wide; the state and priority glyphs of design system 2.4 and
 * 2.5 are solid shapes so they still read at 12 px.
 */
interface IconDrawing {
  readonly kind: 'line' | 'solid';
  readonly shapes: ReactNode;
}

const line = (shapes: ReactNode): IconDrawing => ({ kind: 'line', shapes });
const solid = (shapes: ReactNode): IconDrawing => ({ kind: 'solid', shapes });

/** A filled dot inside a line icon (the point of "!", "i" and "?"). */
const point = (cx: number, cy: number) => (
  <circle cx={cx} cy={cy} r={1} fill="currentColor" stroke="none" />
);

const ICONS = {
  // Design system 4.13, in its order.
  menu: line(<path d="M3 5h14M3 10h14M3 15h14" />),
  close: line(<path d="M5 5l10 10M15 5L5 15" />),
  'chevron-down': line(<path d="M5 7.5l5 5 5-5" />),
  'chevron-up': line(<path d="M5 12.5l5-5 5 5" />),
  'chevron-left': line(<path d="M12.5 5l-5 5 5 5" />),
  'chevron-right': line(<path d="M7.5 5l5 5-5 5" />),
  check: line(<path d="M4 10.5l4 4 8-9" />),
  alert: line(
    <>
      <path d="M10 3l7.5 13.5h-15z" />
      <path d="M10 8.5v3.5" />
      {point(10, 14.25)}
    </>,
  ),
  info: line(
    <>
      <circle cx={10} cy={10} r={7.25} />
      <path d="M10 9v5" />
      {point(10, 6.25)}
    </>,
  ),
  play: solid(<path d="M6 4l10 6-10 6z" />),
  pause: solid(
    <>
      <rect x={5} y={4} width={3.5} height={12} rx={0.5} />
      <rect x={11.5} y={4} width={3.5} height={12} rx={0.5} />
    </>,
  ),
  stop: solid(<rect x={5} y={5} width={10} height={10} rx={1} />),
  wrench: line(
    <path d="M12.75 3.25a4 4 0 0 0-3.9 5.05L3.6 13.55a1.45 1.45 0 0 0 2.05 2.05l5.25-5.25a4 4 0 0 0 5.05-3.9l-2.3 2.3-2.15-.6-.6-2.15z" />,
  ),
  ban: line(
    <>
      <circle cx={10} cy={10} r={7.25} />
      <path d="M4.9 4.9l10.2 10.2" />
    </>,
  ),
  'arrow-left': line(<path d="M16 10H4M9 5l-5 5 5 5" />),
  'arrow-right': line(<path d="M4 10h12M11 5l5 5-5 5" />),
  external: line(<path d="M11 4h5v5M16 4l-7 7M14 11.5V16H4V6h4.5" />),
  download: line(<path d="M10 3v10M6 9l4 4 4-4M4 16.5h12" />),
  print: line(<path d="M6 7V3h8v4M6 14H4V7h12v7h-2M6 11h8v6H6z" />),
  search: line(
    <>
      <circle cx={9} cy={9} r={5.25} />
      <path d="M13 13l4 4" />
    </>,
  ),
  user: line(
    <>
      <circle cx={10} cy={6.75} r={3.25} />
      <path d="M3.5 17a6.5 6.5 0 0 1 13 0" />
    </>,
  ),
  logout: line(<path d="M8 4H4v12h4M12.5 6l4 4-4 4M16.5 10H8" />),
  filter: line(<path d="M3 4h14l-5.5 6.5V16l-3-1.5v-4z" />),
  clock: line(
    <>
      <circle cx={10} cy={10} r={7.25} />
      <path d="M10 6v4l2.75 2.25" />
    </>,
  ),

  // The state and priority glyphs of design system 2.4 and 2.5 not in the list above.
  /** ⟳ Setup. */
  rotate: line(<path d="M16 10a6 6 0 1 1-1.76-4.24M16 3.5V7h-3.5" />),
  /** ○ Off. */
  circle: line(<circle cx={10} cy={10} r={5.5} />),
  /** ◀ Starved: input missing. */
  'triangle-left': solid(<path d="M14 4L4 10l10 6z" />),
  /** ▶▮ Blocked: output blocked. */
  'play-bar': solid(
    <>
      <path d="M3 4l8.5 6L3 16z" />
      <rect x={13.5} y={4} width={3.5} height={12} rx={0.5} />
    </>,
  ),
  /** ? No data. */
  question: line(
    <>
      <path d="M7.5 7.5a2.5 2.5 0 1 1 3.6 2.25c-.7.35-1.1.9-1.1 1.6V12" />
      {point(10, 15)}
    </>,
  ),
  /** ▲ Medium priority. */
  'triangle-up': solid(<path d="M10 4l7 12H3z" />),
  /** ▲▲ High priority. */
  'triangles-up': solid(<path d="M5.5 5L10 15H1zM14.5 5L19 15h-9z" />),
  /** ● Low priority. */
  dot: solid(<circle cx={10} cy={10} r={4.5} />),
  /** The loading spinner's arc (it turns by the button's class, not by itself). */
  spinner: line(<path d="M10 3a7 7 0 1 1-7 7" />),
} satisfies Record<string, IconDrawing>;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export type IconSize = 12 | 16 | 20 | 24;

export interface IconProps {
  readonly name: IconName;
  /** Pixels; 16 by default, 12 in a badge, 20 beside larger text. */
  readonly size?: IconSize;
  readonly className?: string;
}

/** One icon, decorative: `aria-hidden`, never focusable, in the text's colour. */
export function Icon({ name, size = 16, className }: IconProps) {
  const drawing: IconDrawing = ICONS[name];
  const paint =
    drawing.kind === 'line'
      ? {
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.75,
          strokeLinecap: 'round' as const,
          strokeLinejoin: 'round' as const,
        }
      : { fill: 'currentColor', stroke: 'none' };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      data-icon={name}
      className={className === undefined ? 'shrink-0' : `shrink-0 ${className}`}
      {...paint}
    >
      {drawing.shapes}
    </svg>
  );
}
