import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import {
  BREAKPOINTS,
  COLOR_TOKENS,
  DURATIONS,
  EASINGS,
  FONTS,
  MACHINE_STATES,
  NEUTRAL_SCALE,
  PRIORITIES,
  RADII,
  SHADOWS,
  SPACING,
  TEXT_SIZES,
  TONES,
  type Theme,
  Z_INDEX,
  colorValue,
  contrastRatio,
} from './tokens.ts';

/**
 * UX-1a (#314): the token map, `src/index.css` and the design system's contrast ratios agree.
 * Every token is a CSS variable with its value, a Tailwind utility, and (for a colour) has its
 * dark value under `:root[data-theme='dark']`; every ratio the design system states (sections 2
 * and 8) is recomputed from the token values.
 */

const CSS_PATH = join(import.meta.dirname, '..', '..', 'index.css');
const css = readFileSync(CSS_PATH, 'utf8');

/**
 * The declarations of the first block whose selector line is `prelude` (nested `indent` deep: a
 * rule inside `@media` ends at its own indented brace).
 */
function declarations(prelude: string, indent = ''): Map<string, string> {
  const start = css.indexOf(`${indent}${prelude} {`);
  expect(start, `${prelude} block`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf(`\n${indent}}\n`, start));
  const found = new Map<string, string>();
  for (const match of body
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    const [, name = '', value = ''] = match;
    found.set(name, value.replaceAll(/\s+/g, ' ').trim());
  }
  return found;
}

const theme = declarations('@theme static');
const dark = declarations(":root[data-theme='dark']");
/** UX-12: the dark values when `data-theme` is absent (scripts off), on screen only. */
const MEDIA_PRELUDE =
  '@media screen and (prefers-color-scheme: dark) {\n  :root:not([data-theme]) {';
const systemDark = declarations(':root:not([data-theme])', '  ');

/** Every variable `@theme` must define, with its value. */
function expectedTheme(): Map<string, string> {
  const expected = new Map<string, string>();
  for (const [name, value] of Object.entries(NEUTRAL_SCALE)) expected.set(`--color-${name}`, value);
  for (const token of COLOR_TOKENS) expected.set(`--color-${token.name}`, token.light);
  for (const [name, value] of Object.entries(FONTS)) expected.set(`--font-${name}`, value);
  for (const [name, [size, lineHeight]] of Object.entries(TEXT_SIZES)) {
    expected.set(`--text-${name}`, size);
    expected.set(`--text-${name}--line-height`, lineHeight);
  }
  expected.set('--spacing', SPACING);
  for (const [name, value] of Object.entries(RADII)) expected.set(`--radius-${name}`, value);
  for (const [name, value] of Object.entries(SHADOWS)) expected.set(`--shadow-${name}`, value);
  for (const [name, value] of Object.entries(Z_INDEX)) expected.set(`--z-${name}`, String(value));
  for (const [name, value] of Object.entries(DURATIONS)) expected.set(`--duration-${name}`, value);
  for (const [name, value] of Object.entries(EASINGS)) expected.set(`--ease-${name}`, value);
  for (const [name, value] of Object.entries(BREAKPOINTS)) {
    expected.set(`--breakpoint-${name}`, value);
  }
  return expected;
}

describe('the token map and src/index.css', () => {
  it('defines exactly the mapped tokens in @theme, with their light values', () => {
    expect(Object.fromEntries(theme)).toEqual(Object.fromEntries(expectedTheme()));
  });

  it('gives every colour token whose dark value differs that value in the dark block, and nothing else', () => {
    const expected = new Map<string, string>();
    for (const token of COLOR_TOKENS) {
      if (token.dark !== token.light) expected.set(`--color-${token.name}`, token.dark);
    }
    expect(Object.fromEntries(dark)).toEqual(Object.fromEntries(expected));
    expect(css).toMatch(/:root\[data-theme='dark'\] \{\s*color-scheme: dark;/);
  });

  it('applies the same dark values under prefers-color-scheme: dark while data-theme is absent, on screen only (UX-12)', () => {
    expect(css).toContain(MEDIA_PRELUDE);
    expect(css.indexOf(MEDIA_PRELUDE)).toBe(css.lastIndexOf(MEDIA_PRELUDE));
    expect(systemDark.size).toBeGreaterThan(0);
    expect(Object.fromEntries(systemDark)).toEqual(Object.fromEntries(dark));
    expect(css).toMatch(/:root:not\(\[data-theme\]\) \{\s*color-scheme: dark;/);
    // Light by default, so the form controls and scroll bars follow the theme in use.
    expect(css).toMatch(/\n:root \{\s*color-scheme: light;\s*\}/);
  });

  it('has no duplicate colour names and covers every tone, state and priority', () => {
    const names = COLOR_TOKENS.map((token) => token.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tone of TONES) {
      for (const part of ['ink', 'soft', 'border', 'solid', 'on-solid']) {
        expect(names).toContain(`${tone}-${part}`);
      }
    }
    for (const key of [
      ...MACHINE_STATES.map((s) => `state-${s}`),
      ...PRIORITIES.map((p) => `priority-${p}`),
    ]) {
      for (const part of ['fill', 'ink', 'border']) expect(names).toContain(`${key}-${part}`);
    }
    // The names design system section 2 uses.
    for (const name of [
      'canvas',
      'surface',
      'surface-sunken',
      'line',
      'line-subtle',
      'line-strong',
      'ink',
      'ink-secondary',
      'ink-inverse',
      'accent',
      'accent-hover',
      'accent-subtle',
      'nav-active',
      'nav-active-bar',
      'focus',
      'focus-on-dark',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('keeps the semantic aliases of design system 2.1 on the neutral scale', () => {
    const aliases: Record<string, string> = {
      canvas: 'neutral-100',
      surface: 'neutral-0',
      'surface-sunken': 'neutral-50',
      line: 'neutral-300',
      'line-subtle': 'neutral-200',
      'line-strong': 'neutral-500',
      ink: 'neutral-900',
      'ink-secondary': 'neutral-600',
      'ink-inverse': 'neutral-0',
    };
    for (const [alias, step] of Object.entries(aliases)) {
      expect(colorValue(alias, 'light'), alias).toBe(NEUTRAL_SCALE[step]);
    }
  });

  it('draws the focus ring in the focus token and hides it on script-focused headings and main (G-22)', () => {
    expect(css).toMatch(
      /:focus-visible \{\s*outline: 2px solid var\(--color-focus\);\s*outline-offset: 2px;\s*\}/,
    );
    expect(css).toMatch(
      /\[data-surface='dark'\]:focus-visible,\s*\[data-surface='dark'\] :focus-visible \{\s*outline-color: var\(--color-focus-on-dark\);\s*\}/,
    );
    // A light surface inside the dark top bar (the theme menu) has the `focus` ring again.
    expect(css).toMatch(
      /\[data-surface='dark'\] \[data-surface='light'\]:focus-visible,\s*\[data-surface='dark'\] \[data-surface='light'\] :focus-visible \{\s*outline-color: var\(--color-focus\);\s*\}/,
    );
    expect(css).toMatch(
      /h1\[tabindex='-1'\]:focus-visible,\s*main\[tabindex='-1'\]:focus \{\s*outline: none;\s*\}/,
    );
  });
});

describe('every token as a Tailwind utility', async () => {
  const require = createRequire(join(import.meta.dirname, 'tokens.test.ts'));
  const tailwindDir = dirname(require.resolve('tailwindcss/package.json'));
  const compiler = await compile(css, {
    base: dirname(CSS_PATH),
    loadStylesheet: (id: string) => {
      const path = id === 'tailwindcss' ? join(tailwindDir, 'index.css') : id;
      return Promise.resolve({ path, base: dirname(path), content: readFileSync(path, 'utf8') });
    },
  });

  /** The rule body Tailwind generates for one class, or undefined when it generates none. */
  function rule(candidate: string): string | undefined {
    const out = compiler.build([candidate]);
    const selector = `.${candidate.replaceAll(':', String.raw`\:`)} {`;
    const at = out.indexOf(selector);
    return at < 0 ? undefined : out.slice(at, out.indexOf('}', at));
  }

  it('leaves no Tailwind default in the neutral scale: every --color-neutral-<step> is ours', () => {
    const out = compiler.build([]);
    const steps = [...out.matchAll(/--color-(neutral-\d+): ([^;]+);/g)].map(
      ([, name = '', value = '']) => [name, value] as const,
    );
    expect(Object.fromEntries(steps)).toEqual(NEUTRAL_SCALE);
    expect(rule('bg-neutral-950')).toContain('var(--color-neutral-950)');
  });

  it('registers --tw-duration as not inherited, so a child keeps its own transition duration', () => {
    expect(css).toMatch(/@property --tw-duration \{\s*syntax: '\*';\s*inherits: false;\s*\}/);
    const out = compiler.build(['duration-base', 'transition']);
    const registered = /@property --tw-duration \{[^}]*inherits: false;[^}]*\}/.exec(out);
    expect(registered).not.toBeNull();
  });

  it('emits every @theme variable, used or not (static)', () => {
    const out = compiler.build([]);
    for (const [name, value] of expectedTheme()) {
      expect(out, name).toContain(`${name}: ${value}`);
    }
  });

  it('makes a background, text and border utility of every colour', () => {
    for (const name of [...Object.keys(NEUTRAL_SCALE), ...COLOR_TOKENS.map((t) => t.name)]) {
      for (const utility of ['bg', 'text', 'border']) {
        expect(rule(`${utility}-${name}`), `${utility}-${name}`).toContain(`var(--color-${name})`);
      }
    }
  });

  it('makes the type, radius, shadow, z-index, motion, font and spacing utilities', () => {
    for (const size of Object.keys(TEXT_SIZES)) {
      expect(rule(`text-${size}`)).toContain(`var(--text-${size})`);
      expect(rule(`text-${size}`)).toContain(`var(--text-${size}--line-height)`);
    }
    for (const name of Object.keys(RADII)) {
      expect(rule(`rounded-${name}`)).toContain(`var(--radius-${name})`);
    }
    for (const [name, value] of Object.entries(SHADOWS)) {
      // Tailwind writes the shadow's value into the utility (its colour stays overridable).
      const [geometry] = value.split(' rgb');
      expect(rule(`shadow-${name}`)).toContain(geometry);
    }
    for (const name of Object.keys(Z_INDEX)) {
      expect(rule(`z-${name}`)).toContain(`z-index: var(--z-${name})`);
    }
    for (const name of Object.keys(DURATIONS)) {
      expect(rule(`duration-${name}`)).toContain(`transition-duration: var(--duration-${name})`);
    }
    for (const name of Object.keys(EASINGS)) {
      expect(rule(`ease-${name}`)).toContain(`var(--ease-${name})`);
    }
    for (const name of Object.keys(FONTS)) {
      expect(rule(`font-${name}`)).toContain(`var(--font-${name})`);
    }
    expect(rule('p-4')).toContain('calc(var(--spacing) * 4)');
  });

  it('adds the wide breakpoint at 1440 px, between xl and 2xl', () => {
    const out = compiler.build(['xl:flex', 'wide:flex', '2xl:flex']);
    expect(out).toContain('@media (width >= 90rem)');
    const order = ['80rem', '90rem', '96rem'].map((width) => out.indexOf(`(width >= ${width})`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

/** A ratio the design system states: foreground, background, the theme, its ratio, its floor. */
type Pair = readonly [fg: string, bg: string, theme: Theme, ratio: number, min: number];

const TEXT = 4.5;
const NON_TEXT = 3;

/** Design system section 2 (light), each pair as the spec writes it. */
const LIGHT_PAIRS: readonly Pair[] = [
  // 2.2
  ['nav-active-ink', 'nav-active', 'light', 9.46, TEXT],
  ['nav-active-bar', 'nav', 'light', 6.83, NON_TEXT],
  // The active item's fill against the nav: low by design, the bar and the text carry the state.
  ['nav-active', 'nav', 'light', 1.55, 1],
  // 2.3: ink on soft, border on white, solid text on solid.
  ['neutral-ink', 'neutral-soft', 'light', 9.45, TEXT],
  ['info-ink', 'info-soft', 'light', 8.01, TEXT],
  ['ok-ink', 'ok-soft', 'light', 7.29, TEXT],
  ['warn-ink', 'warn-soft', 'light', 8.75, TEXT],
  ['caution-ink', 'caution-soft', 'light', 8.83, TEXT],
  ['alarm-ink', 'alarm-soft', 'light', 7.6, TEXT],
  ['neutral-border', 'surface', 'light', 4.76, NON_TEXT],
  ['info-border', 'surface', 'light', 5.17, NON_TEXT],
  ['ok-border', 'surface', 'light', 5.48, NON_TEXT],
  ['warn-border', 'surface', 'light', 5.02, NON_TEXT],
  ['caution-border', 'surface', 'light', 5.18, NON_TEXT],
  ['alarm-border', 'surface', 'light', 6.47, NON_TEXT],
  ['neutral-on-solid', 'neutral-solid', 'light', 10.35, TEXT],
  ['info-on-solid', 'info-solid', 'light', 6.7, TEXT],
  ['ok-on-solid', 'ok-solid', 'light', 5.48, TEXT],
  ['warn-on-solid', 'warn-solid', 'light', 10.39, TEXT],
  ['caution-on-solid', 'caution-solid', 'light', 9.28, TEXT],
  ['alarm-on-solid', 'alarm-solid', 'light', 6.47, TEXT],
  ['info-border', 'canvas', 'light', 4.72, NON_TEXT],
  // 2.4
  ['state-running-ink', 'state-running-fill', 'light', 16.3, TEXT],
  ['state-idle-ink', 'state-idle-fill', 'light', 14.48, TEXT],
  ['state-setup-ink', 'state-setup-fill', 'light', 14.48, TEXT],
  ['state-planned-stop-ink', 'state-planned-stop-fill', 'light', 9.9, TEXT],
  ['state-maintenance-ink', 'state-maintenance-fill', 'light', 6.7, TEXT],
  ['state-off-ink', 'state-off-fill', 'light', 6.92, TEXT],
  ['state-starved-ink', 'state-starved-fill', 'light', 10.39, TEXT],
  ['state-blocked-ink', 'state-blocked-fill', 'light', 9.28, TEXT],
  ['state-stopped-ink', 'state-stopped-fill', 'light', 8.2, TEXT],
  ['state-down-ink', 'state-down-fill', 'light', 6.47, TEXT],
  ['state-no-data-ink', 'state-no-data-fill', 'light', 7.58, TEXT],
  ['state-starved-border', 'surface', 'light', 5.02, NON_TEXT],
  ['state-blocked-border', 'surface', 'light', 5.18, NON_TEXT],
  // 2.5
  ['priority-high-ink', 'priority-high-fill', 'light', 6.47, TEXT],
  ['priority-medium-ink', 'priority-medium-fill', 'light', 8.97, TEXT],
  ['priority-low-ink', 'priority-low-fill', 'light', 8.72, TEXT],
  // 3.2, 4.1, 5 and 7
  ['nav-heading', 'nav', 'light', 5.71, TEXT],
  ['nav-ink', 'nav', 'light', 11.87, TEXT],
  ['nav-ink', 'nav-hover', 'light', 8.4, TEXT],
  ['on-accent', 'accent', 'light', 7.56, TEXT],
  ['on-accent', 'accent-hover', 'light', 9.46, TEXT],
  ['alarm-on-solid', 'alarm-solid-hover', 'light', 8.31, TEXT],
  ['link', 'surface', 'light', 7.56, TEXT],
  ['disabled-ink', 'disabled', 'light', 6.92, TEXT],
  ['ink-secondary', 'surface', 'light', 7.58, TEXT],
  ['ink-secondary', 'canvas', 'light', 6.92, TEXT],
  ['line-strong', 'surface', 'light', 4.76, NON_TEXT],
  // neutral-500 is under 4.5 on the canvas: never text (section 7).
  ['line-strong', 'canvas', 'light', 4.34, NON_TEXT],
  ['focus', 'surface', 'light', 5.93, NON_TEXT],
  ['focus-on-dark', 'topbar', 'light', 8.33, NON_TEXT],
  ['chart-1', 'surface', 'light', 5.93, NON_TEXT],
  ['chart-2', 'surface', 'light', 5.02, NON_TEXT],
  ['chart-3', 'surface', 'light', 7.1, NON_TEXT],
  ['chart-4', 'surface', 'light', 5.48, NON_TEXT],
  ['chart-5', 'surface', 'light', 6.04, NON_TEXT],
];

/** Design system section 8 (dark): the stated pairs, then the ones UX-1a added to its table. */
const DARK_PAIRS: readonly Pair[] = [
  ['ink', 'canvas', 'dark', 15.19, TEXT],
  ['alarm-on-solid', 'alarm-solid-hover', 'dark', 6.47, TEXT],
  ['ink', 'surface', 'dark', 14.12, TEXT],
  ['ink-secondary', 'surface', 'dark', 6.79, TEXT],
  ['line-strong', 'surface', 'dark', 3.66, NON_TEXT],
  ['link', 'surface', 'dark', 10.44, TEXT],
  ['on-accent', 'accent', 'dark', 8.74, TEXT],
  ['focus', 'surface', 'dark', 8.13, NON_TEXT],
  ['state-running-ink', 'state-running-fill', 'dark', 11.87, TEXT],
  ['nav-active-ink', 'nav-active', 'dark', 9.46, TEXT],
  ['state-idle-ink', 'state-idle-fill', 'dark', 8.4, TEXT],
  ['state-starved-ink', 'state-starved-fill', 'dark', 10.39, TEXT],
  ['state-down-ink', 'state-down-fill', 'dark', 4.83, TEXT],
  ['state-down-fill', 'surface', 'dark', 3.6, NON_TEXT],
  ['alarm-ink', 'alarm-soft', 'dark', 9.25, TEXT],
  ['warn-ink', 'warn-soft', 'dark', 11.0, TEXT],
  ['ok-ink', 'ok-soft', 'dark', 10.02, TEXT],
  ['info-ink', 'info-soft', 'dark', 9.26, TEXT],
  ['info-border', 'surface', 'dark', 6.85, NON_TEXT],
  ['chart-1', 'surface', 'dark', 8.13, NON_TEXT],
  ['chart-2', 'surface', 'dark', 8.1, NON_TEXT],
  ['chart-limit', 'surface', 'dark', 6.29, NON_TEXT],
  // Added with UX-1a (section 8, "the other dark values").
  ['ink-secondary', 'canvas', 'dark', 7.3, TEXT],
  ['ink', 'surface-hover', 'dark', 11.87, TEXT],
  ['disabled-ink', 'disabled', 'dark', 5.71, TEXT],
  ['on-accent', 'accent-hover', 'dark', 11.23, TEXT],
  ['ink', 'accent-subtle', 'dark', 11.47, TEXT],
  ['neutral-ink', 'neutral-soft', 'dark', 9.85, TEXT],
  ['caution-ink', 'caution-soft', 'dark', 9.9, TEXT],
  ['neutral-border', 'surface', 'dark', 3.66, NON_TEXT],
  ['ok-border', 'surface', 'dark', 6.86, NON_TEXT],
  ['warn-border', 'surface', 'dark', 8.1, NON_TEXT],
  ['caution-border', 'surface', 'dark', 6.21, NON_TEXT],
  ['alarm-border', 'surface', 'dark', 6.29, NON_TEXT],
  ['neutral-on-solid', 'neutral-solid', 'dark', 7.58, TEXT],
  ['info-on-solid', 'info-solid', 'dark', 5.17, TEXT],
  ['ok-on-solid', 'ok-solid', 'dark', 5.48, TEXT],
  ['alarm-on-solid', 'alarm-solid', 'dark', 4.83, TEXT],
  ['state-setup-ink', 'state-setup-fill', 'dark', 8.4, TEXT],
  ['state-planned-stop-ink', 'state-planned-stop-fill', 'dark', 12.18, TEXT],
  ['state-maintenance-ink', 'state-maintenance-fill', 'dark', 5.17, TEXT],
  ['state-off-ink', 'state-off-fill', 'dark', 6.79, TEXT],
  ['state-stopped-ink', 'state-stopped-fill', 'dark', 9.25, TEXT],
  ['state-no-data-ink', 'state-no-data-fill', 'dark', 6.79, TEXT],
  ['priority-high-ink', 'priority-high-fill', 'dark', 4.83, TEXT],
  ['priority-medium-ink', 'priority-medium-fill', 'dark', 8.97, TEXT],
  ['priority-low-ink', 'priority-low-fill', 'dark', 9.65, TEXT],
  ['chart-3', 'surface', 'dark', 6.4, NON_TEXT],
  ['chart-4', 'surface', 'dark', 9.05, NON_TEXT],
  ['chart-5', 'surface', 'dark', 6.57, NON_TEXT],
  ['chart-other', 'surface', 'dark', 11.72, NON_TEXT],
];

describe('contrast (design system sections 2 and 8, WCAG 2.x)', () => {
  it('computes WCAG contrast', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 10);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    // A channel at or under 10/255 is on the linear part of the sRGB curve.
    expect(contrastRatio('#0a0a0a', '#ffffff').toFixed(2)).toBe('19.80');
    expect(contrastRatio('#0f172a', '#ffffff')).toBe(contrastRatio('#ffffff', '#0f172a'));
    expect(() => contrastRatio('rgb(0 0 0)', '#ffffff')).toThrow(/#rrggbb/);
  });

  it.each([...LIGHT_PAIRS, ...DARK_PAIRS])(
    '%s on %s (%s) is %f, at least %f',
    (fg, bg, which, ratio, min) => {
      const actual = contrastRatio(colorValue(fg, which), colorValue(bg, which));
      expect(actual.toFixed(2)).toBe(ratio.toFixed(2));
      expect(actual).toBeGreaterThanOrEqual(min);
    },
  );

  it.each(['light', 'dark'] as const)(
    'meets AA for every tone, state and priority (%s)',
    (which) => {
      const ratio = (fg: string, bg: string) =>
        contrastRatio(colorValue(fg, which), colorValue(bg, which));
      for (const tone of TONES) {
        expect(ratio(`${tone}-ink`, `${tone}-soft`), `${tone} soft`).toBeGreaterThanOrEqual(TEXT);
        expect(ratio(`${tone}-on-solid`, `${tone}-solid`), `${tone} solid`).toBeGreaterThanOrEqual(
          TEXT,
        );
        expect(ratio(`${tone}-border`, 'surface'), `${tone} border`).toBeGreaterThanOrEqual(
          NON_TEXT,
        );
        expect(ratio(`${tone}-ink`, 'surface'), `${tone} ink on surface`).toBeGreaterThanOrEqual(
          TEXT,
        );
      }
      for (const key of [
        ...MACHINE_STATES.map((s) => `state-${s}`),
        ...PRIORITIES.map((p) => `priority-${p}`),
      ]) {
        expect(ratio(`${key}-ink`, `${key}-fill`), key).toBeGreaterThanOrEqual(TEXT);
      }
      for (const text of ['ink', 'ink-secondary', 'link']) {
        for (const ground of ['canvas', 'surface', 'surface-sunken', 'surface-hover']) {
          expect(ratio(text, ground), `${text} on ${ground}`).toBeGreaterThanOrEqual(TEXT);
        }
      }
      for (const ring of ['focus', 'line-strong']) {
        for (const ground of ['canvas', 'surface']) {
          expect(ratio(ring, ground), `${ring} on ${ground}`).toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
      for (const fill of ['accent', 'accent-hover']) {
        expect(ratio('on-accent', fill), `on-accent on ${fill}`).toBeGreaterThanOrEqual(TEXT);
      }
      expect(ratio('focus-on-dark', 'topbar')).toBeGreaterThanOrEqual(NON_TEXT);
      expect(ratio('focus-on-dark', 'nav')).toBeGreaterThanOrEqual(NON_TEXT);
    },
  );

  // UX-12: every text colour a screen sets on every ground it can sit on, not only its own pair:
  // a tone's text in a table row under the pointer, a link on a selected row, an `ok` value in a
  // `warn` callout. And every meaningful edge (a ring, a control's border, a tone's border, a
  // ghost button's text) on every plain ground.
  it.each(['light', 'dark'] as const)(
    'meets AA for every text colour on every ground, and every edge on every plain ground (%s)',
    (which) => {
      const ratio = (fg: string, bg: string) =>
        contrastRatio(colorValue(fg, which), colorValue(bg, which));
      const plain = ['canvas', 'surface', 'surface-sunken', 'surface-hover'];
      const grounds = [
        ...plain,
        'accent-subtle',
        'disabled',
        'line-subtle',
        ...TONES.map((tone) => `${tone}-soft`),
      ];
      const texts = [
        'ink',
        'ink-secondary',
        'link',
        'accent',
        'disabled-ink',
        ...TONES.map((tone) => `${tone}-ink`),
      ];
      for (const text of texts) {
        for (const ground of grounds) {
          expect(ratio(text, ground), `${text} on ${ground}`).toBeGreaterThanOrEqual(TEXT);
        }
      }
      const edges = ['line-strong', 'focus', 'accent', ...TONES.map((tone) => `${tone}-border`)];
      for (const edge of edges) {
        for (const ground of plain) {
          expect(ratio(edge, ground), `${edge} on ${ground}`).toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    },
  );
});
