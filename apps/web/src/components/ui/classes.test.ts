import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

/**
 * UX-1c (#315): every class the primitives and the domain badges draw with is one Tailwind
 * generates from the tokens of `index.css`, and none is a raw colour. A misspelt token
 * (`bg-surfce`) or a raw class renders nothing or bypasses the theme, and no DOM test notices.
 *
 * The classes are harvested from the source, as Tailwind's own scanner finds them: every string
 * literal and every static part of a template literal in the files below that looks like a class
 * list (a token with a utility prefix in it) is split into its classes, and each must compile.
 */
const SRC = join(import.meta.dirname, '..', '..');
const CSS_PATH = join(SRC, 'index.css');
const css = readFileSync(CSS_PATH, 'utf8');

/** The primitives, the domain badges, the state palette and the shell: drawn on the tokens only. */
const FILES = [
  ...readdirSync(join(SRC, 'components/ui'))
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx') && f !== 'icons.tsx')
    .map((f) => `components/ui/${f}`),
  'components/state-badge.tsx',
  'components/priority-badge.tsx',
  'components/order-badges.tsx',
  'components/finality-badge.tsx',
  'components/loss-badge.tsx',
  'domain/states.ts',
  // The shell (UX-1b, #316).
  'screens/root-layout.tsx',
  'auth/shell.tsx',
  'components/connection-status.tsx',
  // Login and account (UX-11, #335).
  'screens/login.tsx',
  'screens/account.tsx',
  // The chart frames (UX-1f, #320).
  'chart/echart.tsx',
  'chart/trend-chart.tsx',
  // The migrated screens: a screen on the tokens draws only classes Tailwind generates.
  'screens/order-list.tsx',
  'screens/order-detail.tsx',
  // Order actions and order OEE (UX-6b, #329).
  'screens/order-actions.tsx',
  'screens/order-oee.tsx',
  // The traceability screens (UX-8, #331).
  'screens/trace-common.tsx',
  'screens/trace-search.tsx',
  'screens/trace-serial.tsx',
  'screens/trace-lot.tsx',
  'screens/trace-carton.tsx',
  // Quality holds (UX-9b, #333).
  'screens/holds.tsx',
  // The OEE dashboard and line OEE (UX-3, #323).
  'screens/oee-dashboard.tsx',
  'screens/line-oee.tsx',
  'components/oee-ui.tsx',
  // The simulation console and the users (UX-10, #334).
  'screens/console.tsx',
  'screens/users.tsx',
];

/** Utility prefixes: a literal with one of these is a class list. */
const UTILITY =
  /^(?:[a-z-]+:)*-?(?:bg|text|border|min|max|px|py|pt|pb|pl|pr|p|mx|my|mt|mb|ml|mr|m|gap|rounded|font|leading|w|h|size|columns|shadow|z|duration|ease|line|break|whitespace|tabular|inline|flex|grid|items|justify|shrink|sr|motion|animate|cursor|underline|transition|hidden|block|outline|ring|opacity|top|left|right|bottom|inset|overflow|truncate|align|self|col|row|basis|grow|space|divide|fill|stroke|decoration|tracking|uppercase|sticky|absolute|relative|fixed|static)(?:-|$)/;

/** The code without comments (an apostrophe in a comment would open a string literal). */
function withoutComments(source: string): string {
  return source.replaceAll(
    /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, literal: string | undefined) => literal ?? '',
  );
}

/**
 * The static text of every string and template literal in `code`: a template's parts between
 * its `${…}` expressions, and the literals inside those expressions (nested templates included).
 */
function literals(code: string): string[] {
  const found: string[] = [];
  let at = 0;
  /** Reads the template literal whose opening backtick is at `start`; returns the index after it. */
  const template = (start: number): number => {
    let part = '';
    let i = start + 1;
    while (i < code.length && code[i] !== '`') {
      if (code[i] === '\\') {
        part += code.slice(i, i + 2);
        i += 2;
      } else if (code.startsWith('${', i)) {
        found.push(part);
        part = '';
        i = expression(i + 2);
      } else {
        part += code[i] ?? '';
        i += 1;
      }
    }
    found.push(part);
    return i + 1;
  };
  /** Reads a `${…}` expression from `start` to its closing brace; returns the index after it. */
  const expression = (start: number): number => {
    let depth = 1;
    let i = start;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (c === '`') i = template(i);
      else if (c === "'" || c === '"') i = quoted(i);
      else {
        if (c === '{') depth += 1;
        if (c === '}') depth -= 1;
        i += 1;
      }
    }
    return i;
  };
  const quoted = (start: number): number => {
    const quote = code[start];
    let i = start + 1;
    let text = '';
    while (i < code.length && code[i] !== quote && code[i] !== '\n') {
      if (code[i] === '\\') i += 1;
      text += code[i] ?? '';
      i += 1;
    }
    found.push(text);
    return i + 1;
  };
  while (at < code.length) {
    const c = code[at];
    if (c === '`') at = template(at);
    else if (c === "'" || c === '"') at = quoted(at);
    else at += 1;
  }
  return found;
}

/** A token that can be a class: lower case, digits and Tailwind's punctuation. */
const CLASS_LIKE = /^[a-z0-9:[\]().%/_!-]+$/;

function harvest(file: string): string[] {
  const code = withoutComments(readFileSync(join(SRC, file), 'utf8'));
  return literals(code)
    .map((text) => text.trim().split(/\s+/).filter(Boolean))
    .filter(
      (tokens) =>
        tokens.length > 0 &&
        tokens.every((token) => CLASS_LIKE.test(token)) &&
        tokens.some((token) => UTILITY.test(token)),
    )
    .flat();
}

/** Classes the badges pass to a primitive from files that are not on the tokens yet. */
const PASSED_IN = ['line-through'];

/**
 * Literals that look like a class but are not one (UX-1e, #317): a tooltip's `side` ('top',
 * 'bottom'), a skeleton's `shape` ('text'), the `p` element an empty state renders; and `group`,
 * Tailwind's marker class for `group-open:`, which generates no CSS of its own. UX-1d2 (#319):
 * `size`, a native attribute the form controls set themselves.
 */
const NOT_CLASSES = new Set(['top', 'bottom', 'text', 'p', 'group', 'size']);
/** UX-1d1 (#318): a header cell's `scope="col"`. */
NOT_CLASSES.add('col');
/** UX-2 (#322): a row header cell's `scope: 'row'`. */
NOT_CLASSES.add('row');
/** UX-3 (#323): the line OEE card's test ids and heading id, which start like `line-*` classes. */
for (const id of [
  'line-bottleneck-',
  'line-bottlenecks',
  'line-hour-',
  'line-hours',
  'line-hours-finality',
  'line-oee-above-one',
  'line-oee-card',
  'line-oee-good',
  'line-oee-ideal',
  'line-oee-idle',
  'line-oee-mode',
  'line-oee-planned',
  'line-oee-value',
  'line-title',
]) {
  NOT_CLASSES.add(id);
}
/** UX-10 (#334): the console's repair time unit, `unit="min"`. */
NOT_CLASSES.add('min');

const CLASSES = [...new Set([...FILES.flatMap(harvest), ...PASSED_IN])]
  .filter((c) => !NOT_CLASSES.has(c))
  .sort();

const RAW =
  /(?:^|:)(?:bg|text|border|border-[xytrbl]|ring|outline|fill|stroke|from|to|via|divide|decoration)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+|white|black)(?:\/\S+)?$/;

describe('the primitives’ classes', async () => {
  const require = createRequire(join(import.meta.dirname, 'classes.test.ts'));
  const tailwindDir = dirname(require.resolve('tailwindcss/package.json'));
  const compiler = await compile(css, {
    base: dirname(CSS_PATH),
    loadStylesheet: (id: string) => {
      const path = id === 'tailwindcss' ? join(tailwindDir, 'index.css') : id;
      return Promise.resolve({ path, base: dirname(path), content: readFileSync(path, 'utf8') });
    },
  });

  it('are harvested from every primitive and badge file', () => {
    expect(FILES).toEqual(
      expect.arrayContaining([
        'components/ui/badge.tsx',
        'components/ui/button.tsx',
        'components/ui/callout.tsx',
        'components/ui/card.tsx',
        'components/ui/code.tsx',
        'components/ui/description-list.tsx',
        'components/ui/format.tsx',
        'components/ui/stat.tsx',
      ]),
    );
    // A sample from each: the spinner, Missing, Card, Stat, Code, DescriptionList, Callout.
    expect(CLASSES).toEqual(
      expect.arrayContaining([
        'animate-spin',
        'motion-safe:hidden',
        'text-ink-secondary',
        'border-line',
        'bg-surface',
        'text-3xl',
        'font-semibold',
        'text-[0.95em]',
        'xl:columns-4',
        'rounded-md',
        'bg-state-down-fill',
        'motion-safe:duration-fast',
      ]),
    );
  });

  it('include the form fields’ (UX-1d2, #319)', () => {
    expect(CLASSES).toEqual(
      expect.arrayContaining([
        'border-line-strong',
        'aria-invalid:border-alarm-border',
        'disabled:bg-disabled',
        'accent-accent',
        'text-alarm-ink',
      ]),
    );
  });

  it('are all generated by Tailwind from the tokens', () => {
    // The compiler's output grows with every class it generates (it keeps the earlier ones).
    const missing = CLASSES.filter((candidate) => {
      const before = compiler.build([]);
      return compiler.build([candidate]) === before;
    });
    expect(missing).toEqual([]);
  });

  it('name no raw colour: no Tailwind palette, no raw neutral step, no white or black', () => {
    expect(CLASSES.filter((c) => RAW.test(c))).toEqual([]);
    expect(RAW.test('bg-neutral-100')).toBe(true);
    expect(RAW.test('hover:text-white')).toBe(true);
    expect(RAW.test('bg-neutral-soft')).toBe(false);
  });
});
