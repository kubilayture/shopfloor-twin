/**
 * The design tokens of the web app (UX-1a, #314; `docs/ux/design-system.md` sections 2 and 8) as
 * data. `src/index.css` defines each one in Tailwind's `@theme`, so it is a CSS variable
 * (`var(--color-surface)`) and a utility (`bg-surface`, `text-ink`, `z-dialog`); the dark values
 * sit under `:root[data-theme='dark']` (unused until the theme switch, UX-12). `tokens.test.ts`
 * holds this map, the stylesheet and the design system's contrast ratios together.
 *
 * Screens and components use the semantic names only. The raw neutral scale is the palette the
 * semantic names are picked from: it is the same in both themes, so a component that wants a
 * colour to follow the theme names the semantic token (`surface-hover`, not `neutral-100`).
 */

export type Theme = 'light' | 'dark';

/** A themed colour: `--color-<name>` in `@theme`, its dark value under `[data-theme='dark']`. */
export interface ColorToken {
  readonly name: string;
  readonly light: string;
  readonly dark: string;
}

const color = (name: string, light: string, dark: string = light): ColorToken => ({
  name,
  light,
  dark,
});

/** Design system 2.1: slate. The same in both themes; for the token file, not for screens. */
export const NEUTRAL_SCALE: Readonly<Record<string, string>> = {
  'neutral-0': '#ffffff',
  'neutral-50': '#f8fafc',
  'neutral-100': '#f1f5f9',
  'neutral-200': '#e2e8f0',
  'neutral-300': '#cbd5e1',
  'neutral-400': '#94a3b8',
  'neutral-500': '#64748b',
  'neutral-600': '#475569',
  'neutral-700': '#334155',
  'neutral-800': '#1e293b',
  'neutral-900': '#0f172a',
  'neutral-950': '#020617',
};

/** Surfaces, lines and text (2.1 aliases; dark values from section 8). */
const BASE: readonly ColorToken[] = [
  color('canvas', '#f1f5f9', '#0b1220'),
  color('surface', '#ffffff', '#111a2b'),
  color('surface-sunken', '#f8fafc', '#0e1626'),
  color('surface-hover', '#f1f5f9', '#1e293b'),
  color('line', '#cbd5e1', '#334155'),
  color('line-subtle', '#e2e8f0', '#1e293b'),
  color('line-strong', '#64748b', '#64748b'),
  color('ink', '#0f172a', '#e2e8f0'),
  color('ink-secondary', '#475569', '#94a3b8'),
  color('ink-inverse', '#ffffff', '#0b1220'),
  color('disabled', '#f1f5f9', '#1e293b'),
  color('disabled-line', '#cbd5e1', '#334155'),
  color('disabled-ink', '#475569', '#94a3b8'),
  color('backdrop', 'rgb(15 23 42 / 0.5)', 'rgb(2 6 23 / 0.7)'),
];

/** Actions and links (2.2). In dark the primary fill and the link text differ (section 8). */
const ACCENT: readonly ColorToken[] = [
  color('accent', '#075985', '#38bdf8'),
  color('accent-hover', '#0c4a6e', '#7dd3fc'),
  color('on-accent', '#ffffff', '#0b1220'),
  color('accent-subtle', '#e0f2fe', '#0c2d48'),
  color('link', '#075985', '#7dd3fc'),
  color('nav-active', '#0c4a6e'),
  color('nav-active-ink', '#ffffff'),
  color('nav-active-bar', '#38bdf8'),
  color('focus', '#0369a1', '#38bdf8'),
  color('focus-on-dark', '#38bdf8'),
];

/** The shell's dark chrome (3.2): the same in both themes. */
const SHELL: readonly ColorToken[] = [
  color('topbar', '#0f172a'),
  color('topbar-ink', '#ffffff'),
  color('nav', '#1e293b'),
  color('nav-ink', '#e2e8f0'),
  color('nav-heading', '#94a3b8'),
  color('nav-hover', '#334155'),
];

export const TONES = ['neutral', 'info', 'ok', 'warn', 'caution', 'alarm'] as const;
export type Tone = (typeof TONES)[number];

/** One tone's five colours (2.3): ink on soft, border, solid fill and the text on it. */
interface TonePalette {
  readonly ink: readonly [string, string];
  readonly soft: readonly [string, string];
  readonly border: readonly [string, string];
  readonly solid: readonly [string, string];
  readonly 'on-solid': readonly [string, string];
}

const TONE_PALETTES: Readonly<Record<Tone, TonePalette>> = {
  neutral: {
    ink: ['#334155', '#cbd5e1'],
    soft: ['#f1f5f9', '#1e293b'],
    border: ['#64748b', '#64748b'],
    solid: ['#334155', '#475569'],
    'on-solid': ['#ffffff', '#ffffff'],
  },
  info: {
    ink: ['#1e40af', '#93c5fd'],
    soft: ['#eff6ff', '#0f1d3a'],
    border: ['#2563eb', '#60a5fa'],
    solid: ['#1d4ed8', '#2563eb'],
    'on-solid': ['#ffffff', '#ffffff'],
  },
  ok: {
    ink: ['#065f46', '#6ee7b7'],
    soft: ['#ecfdf5', '#0f2a22'],
    border: ['#047857', '#10b981'],
    solid: ['#047857', '#047857'],
    'on-solid': ['#ffffff', '#ffffff'],
  },
  warn: {
    ink: ['#78350f', '#fcd34d'],
    soft: ['#fffbeb', '#2a2110'],
    border: ['#b45309', '#f59e0b'],
    solid: ['#fcd34d', '#fcd34d'],
    'on-solid': ['#451a03', '#451a03'],
  },
  caution: {
    ink: ['#7c2d12', '#fdba74'],
    soft: ['#fff7ed', '#2b1a10'],
    border: ['#c2410c', '#f97316'],
    solid: ['#fdba74', '#fdba74'],
    'on-solid': ['#431407', '#431407'],
  },
  alarm: {
    ink: ['#991b1b', '#fca5a5'],
    soft: ['#fef2f2', '#2a1215'],
    border: ['#b91c1c', '#f87171'],
    solid: ['#b91c1c', '#dc2626'],
    'on-solid': ['#ffffff', '#ffffff'],
  },
};

export const TONE_PARTS = ['ink', 'soft', 'border', 'solid', 'on-solid'] as const;

const TONE_TOKENS: readonly ColorToken[] = TONES.flatMap((tone) =>
  TONE_PARTS.map((part) => {
    const [light, dark] = TONE_PALETTES[tone][part];
    return color(`${tone}-${part}`, light, dark);
  }),
);

/** The machine states' badges and timeline bands (2.4), by the key `domain/states.ts` uses. */
export const MACHINE_STATES = [
  'running',
  'idle',
  'setup',
  'planned-stop',
  'maintenance',
  'off',
  'starved',
  'blocked',
  'stopped',
  'down',
  'no-data',
] as const;
export type MachineStateKey = (typeof MACHINE_STATES)[number];

/** fill, ink, border; each light then dark. Setup and No data draw their border dashed. */
type Look = readonly [fill: string, ink: string, border: string];
const STATE_LOOKS: Readonly<Record<MachineStateKey, readonly [Look, Look]>> = {
  running: [
    ['#f1f5f9', '#0f172a', '#334155'],
    ['#1e293b', '#e2e8f0', '#cbd5e1'],
  ],
  idle: [
    ['#e2e8f0', '#0f172a', '#e2e8f0'],
    ['#334155', '#e2e8f0', '#334155'],
  ],
  setup: [
    ['#e2e8f0', '#0f172a', '#64748b'],
    ['#334155', '#e2e8f0', '#94a3b8'],
  ],
  'planned-stop': [
    ['#f8fafc', '#334155', '#64748b'],
    ['#0e1626', '#cbd5e1', '#64748b'],
  ],
  maintenance: [
    ['#1d4ed8', '#ffffff', '#1d4ed8'],
    ['#2563eb', '#ffffff', '#2563eb'],
  ],
  off: [
    ['#f1f5f9', '#475569', '#cbd5e1'],
    ['#111a2b', '#94a3b8', '#334155'],
  ],
  starved: [
    ['#fcd34d', '#451a03', '#b45309'],
    ['#fcd34d', '#451a03', '#b45309'],
  ],
  blocked: [
    ['#fdba74', '#431407', '#c2410c'],
    ['#fdba74', '#431407', '#c2410c'],
  ],
  stopped: [
    ['#fee2e2', '#7f1d1d', '#b91c1c'],
    ['#2a1215', '#fca5a5', '#f87171'],
  ],
  down: [
    ['#b91c1c', '#ffffff', '#b91c1c'],
    ['#dc2626', '#ffffff', '#dc2626'],
  ],
  'no-data': [
    ['#ffffff', '#475569', '#64748b'],
    ['#111a2b', '#94a3b8', '#64748b'],
  ],
};

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type PriorityKey = (typeof PRIORITIES)[number];

/** The alarm priority badges (2.5): fill, ink, border; light then dark. */
const PRIORITY_LOOKS: Readonly<Record<PriorityKey, readonly [Look, Look]>> = {
  high: [
    ['#b91c1c', '#ffffff', '#b91c1c'],
    ['#dc2626', '#ffffff', '#dc2626'],
  ],
  medium: [
    ['#fbbf24', '#451a03', '#b45309'],
    ['#fbbf24', '#451a03', '#b45309'],
  ],
  low: [
    ['#ffffff', '#1e40af', '#2563eb'],
    ['#111a2b', '#93c5fd', '#60a5fa'],
  ],
};

function lookTokens(prefix: string, looks: Readonly<Record<string, readonly [Look, Look]>>) {
  return Object.entries(looks).flatMap(
    ([key, [[fill, ink, border], [darkFill, darkInk, darkBorder]]]) => [
      color(`${prefix}-${key}-fill`, fill, darkFill),
      color(`${prefix}-${key}-ink`, ink, darkInk),
      color(`${prefix}-${key}-border`, border, darkBorder),
    ],
  );
}

/** Chart colours (section 5; dark values section 8): the categorical series, "other", limits. */
const CHART: readonly ColorToken[] = [
  color('chart-1', '#0369a1', '#38bdf8'),
  color('chart-2', '#b45309', '#f59e0b'),
  color('chart-3', '#6d28d9', '#a78bfa'),
  color('chart-4', '#047857', '#34d399'),
  color('chart-5', '#be185d', '#f472b6'),
  color('chart-other', '#334155', '#cbd5e1'),
  color('chart-limit', '#b91c1c', '#f87171'),
];

/** Every themed colour, in the stylesheet's order. */
export const COLOR_TOKENS: readonly ColorToken[] = [
  ...BASE,
  ...ACCENT,
  ...SHELL,
  ...TONE_TOKENS,
  ...lookTokens('state', STATE_LOOKS),
  ...lookTokens('priority', PRIORITY_LOOKS),
  ...CHART,
];

/** Type scale (2.7): font size and line height in rem. The weight is set where it is used. */
export const TEXT_SIZES: Readonly<Record<string, readonly [size: string, lineHeight: string]>> = {
  '2xs': ['0.6875rem', '1rem'],
  xs: ['0.75rem', '1rem'],
  sm: ['0.875rem', '1.25rem'],
  base: ['1rem', '1.5rem'],
  lg: ['1.125rem', '1.75rem'],
  xl: ['1.25rem', '1.75rem'],
  '2xl': ['1.5rem', '2rem'],
  '3xl': ['1.875rem', '2.25rem'],
  '4xl': ['2.25rem', '2.5rem'],
};

/** System fonts only (2.7): the CSP fetches no font. */
export const FONTS: Readonly<Record<string, string>> = {
  sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
};

/** The 4 px base of the spacing scale (2.8): Tailwind's `p-1` is 4 px. */
export const SPACING = '0.25rem';

/** Radius (2.9). */
export const RADII: Readonly<Record<string, string>> = {
  sm: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  full: '9999px',
};

/** Elevations 1 to 3 (2.9); elevation 0 is a border and no shadow. The dialog backdrop is `backdrop`. */
export const SHADOWS: Readonly<Record<string, string>> = {
  'elevation-1': '0 1px 2px rgb(15 23 42 / 0.06)',
  'elevation-2': '0 4px 12px rgb(15 23 42 / 0.12)',
  'elevation-3': '0 12px 32px rgb(15 23 42 / 0.24)',
};

/** Layers (2.9), lowest first: `z-sticky` … `z-lock`. */
export const Z_INDEX: Readonly<Record<string, number>> = {
  sticky: 10,
  topbar: 20,
  nav: 30,
  popover: 40,
  toast: 50,
  dialog: 60,
  lock: 70,
};

/** Motion (2.9): `duration-fast`, `duration-base`, `ease-standard`. */
export const DURATIONS: Readonly<Record<string, string>> = { fast: '120ms', base: '200ms' };
export const EASINGS: Readonly<Record<string, string>> = { standard: 'cubic-bezier(0.2, 0, 0, 1)' };

/** The breakpoint added to Tailwind's (3.1): list and detail side by side from 1440 px. */
export const BREAKPOINTS: Readonly<Record<string, string>> = { wide: '90rem' };

/** A colour by token name (themed) or raw neutral step, for the given theme. */
export function colorValue(name: string, theme: Theme): string {
  const token = COLOR_TOKENS.find((candidate) => candidate.name === name);
  if (token) return token[theme];
  const raw = NEUTRAL_SCALE[name];
  if (raw) return raw;
  if (/^#[0-9a-f]{6}$/i.test(name)) return name;
  throw new Error(`unknown colour ${name}`);
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linear((value >> 16) & 255) +
    0.7152 * linear((value >> 8) & 255) +
    0.0722 * linear(value & 255)
  );
}

/** WCAG 2.x contrast ratio of two `#rrggbb` colours, unrounded. */
export function contrastRatio(a: string, b: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) {
    throw new Error(`contrast needs #rrggbb colours, got ${a} and ${b}`);
  }
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
