/**
 * Lists the raw colours still in the web app (UX-1a, #314; `docs/ux/design-system.md` section 8):
 * per file under `apps/web/src`, the Tailwind palette classes (`bg-slate-50`, `hover:text-white`,
 * `border-red-700/40`) and the hex colours (`#b91c1c`). A screen on the design tokens has none:
 * it says `bg-surface`, `text-ink`, `border-alarm-border`. A failing check in `pnpm verify` since
 * UX-F3 (#339): every screen is on the tokens, so any raw colour exits 1 with the files that hold
 * it (it was a report while the screens moved one issue at a time).
 *
 * Skipped: the token files themselves (`src/index.css` and `src/components/ui/tokens.ts`, where
 * the raw values belong) and tests (`*.test.ts(x)`, `src/test/`), whose fixtures may name colours.
 *
 * Also counted (#393 review F3): colour functions with literal arguments (`rgb(15 23 42)`,
 * `oklch(0.6 0.2 30)`, in an arbitrary value such as `text-[rgb(…)]` too) and colour properties
 * given a literal value that names a CSS colour (`style={{ color: 'red' }}`, `fill: 'teal'`), an
 * arbitrary class with one (`text-[red]`, `bg-[color:blue]`) and, in a stylesheet, a declaration
 * with one (`.x { color: red }`); `url(…)`, a template's `${…}` and `context-fill` are no colour. The palettes are Tailwind's own,
 * read from the installed `tailwindcss/theme.css`, so a palette a Tailwind release adds is caught.
 *
 * Comments are left out (an issue number such as `#145` would read as a colour). Known limits (a
 * check, not a parser): a class is found wherever its text appears in the code, strings
 * included; one built at run time from pieces (`bg-${tone}-700`) is not; an apostrophe in JSX
 * text can hide a comment from the comment filter.
 *
 * Usage: node scripts/check-ui-tokens.ts [repository root]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';

/**
 * Tailwind's colour palettes as its installed theme defines them (`--color-<palette>-<step>`), so
 * the list follows the Tailwind release (4.3 added mauve, mist, olive and taupe). `neutral` also
 * has our `neutral-0`.
 */
export function palettesFrom(themeCss: string): string[] {
  return [
    ...new Set(
      [...themeCss.matchAll(/--color-([a-z]+)-(?:50|[1-9]00|950)\s*:/g)].map((m) => m[1] ?? ''),
    ),
  ]
    .filter(Boolean)
    .sort();
}

/** The palettes of the Tailwind the web app installs. */
export function tailwindPalettes(root: string): string[] {
  const require = createRequire(join(root, 'apps/web/package.json'));
  const palettes = palettesFrom(readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8'));
  if (palettes.length === 0)
    throw new Error('check-ui-tokens: no palette in tailwindcss/theme.css');
  return palettes;
}

const REPO = join(import.meta.dirname, '..');
let defaultPalettes: string[] | undefined;
const repoPalettes = (): string[] => (defaultPalettes ??= tailwindPalettes(REPO));

/** The utilities that take a colour. */
const COLOUR_UTILITIES = [
  'bg',
  'text',
  'border',
  'border-[xytrblse]',
  'ring',
  'ring-offset',
  'inset-ring',
  'outline',
  'fill',
  'stroke',
  'from',
  'via',
  'to',
  'divide',
  'decoration',
  'accent',
  'caret',
  'placeholder',
  'shadow',
  'inset-shadow',
  'drop-shadow',
];

/**
 * A palette class with any variants (`md:hover:`) and opacity (`/40`). `white` and `black` count
 * too: on the tokens they are `surface`, `ink-inverse`, `on-accent` …
 */
function classPattern(palettes: readonly string[]): RegExp {
  return new RegExp(
    String.raw`(?<![\w-])(?:[\w-]+:)*(?:${COLOUR_UTILITIES.join('|')})-` +
      String.raw`(?:(?:${palettes.join('|')})-(?:0|50|[1-9]00|950)|white|black)(?:\/[\w.]+)?(?![\w-])`,
    'g',
  );
}

/** A CSS colour function whose first argument is a literal (`rgb(15 23 42 / .5)`), not built. */
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[\d.]/g;

/** A colour property with a literal value (`color: 'red'`, `backgroundColor: "#fff"`). */
const COLOUR_PROPERTY =
  /\b(?:color|[a-zA-Z]+Color|background|fill|stroke)\s*:\s*(['"`])([^'"`\n]*)\1/g;

/** The CSS named colours (`transparent` and `currentColor` name none and are left out). */
const NAMED_COLOURS: ReadonlySet<string> = new Set([
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'black',
  'blanchedalmond',
  'blue',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'fuchsia',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'green',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'lime',
  'limegreen',
  'linen',
  'magenta',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'navy',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'rebeccapurple',
  'red',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'yellowgreen',
]);

/**
 * The named colours a value names, as words: `url(…)` and `${…}` (a template's expression) are
 * left out, so `url(red.png)` and `${tone}` are no colour, nor is `context-fill`.
 */
export function namedColoursIn(value: string): string[] {
  const words = value
    .replace(/url\([^)]*\)/gi, ' ')
    .replace(/\$\{[^}]*\}/g, ' ')
    .split(/[^a-zA-Z-]+/);
  return words.filter((word) => NAMED_COLOURS.has(word.toLowerCase()));
}

/** A colour-taking declaration in a stylesheet (`color: red`, `border: 1px solid navy`). */
const CSS_DECLARATION =
  /(?<![\w-])((?:[a-z-]*-)?(?:color|background|border|outline|fill|stroke|shadow)(?:-[a-z-]+)?)\s*:\s*([^;{}]+)/g;

/** An arbitrary value that is a named colour: `text-[red]`, `bg-[color:blue]`. */
const ARBITRARY_NAMED = /(?<![\w-])(?:[\w-]+:)*[a-z][\w-]*-\[(?:color:)?([a-zA-Z]+)\](?![\w-])/g;

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; not an HTML entity (`&#123;`) or a longer word. */
const HEX = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

/** Files under `apps/web/src` that hold the tokens' raw values on purpose. */
export const TOKEN_FILES = ['src/index.css', 'src/components/ui/tokens.ts'] as const;

export interface RawColours {
  readonly classes: readonly string[];
  readonly hexes: readonly string[];
  /** Colour functions with literal arguments and literal colour property values. */
  readonly values: readonly string[];
}

/** A string literal (kept) or a comment (dropped), in one pass so `//` in a URL stays. */
const STRING_OR_COMMENT =
  /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** The text without its comments, where issue numbers (`#145`) would read as hex colours. */
export function withoutComments(source: string): string {
  return source.replaceAll(
    STRING_OR_COMMENT,
    (match, literal: string | undefined) => literal ?? '',
  );
}

/** The raw palette classes, hex colours and colour values in one file's code, in order. */
export function rawColours(
  source: string,
  palettes: readonly string[] = repoPalettes(),
  { css = false }: { readonly css?: boolean } = {},
): RawColours {
  const code = withoutComments(source);
  return {
    classes: [...code.matchAll(classPattern(palettes))].map((match) => match[0]),
    hexes: [...code.matchAll(HEX)].map((match) => match[0]),
    values: [
      ...[...code.matchAll(COLOUR_FUNCTION)].map((match) => match[0]),
      ...[...code.matchAll(COLOUR_PROPERTY)]
        .filter((match) => namedColoursIn(match[2] ?? '').length > 0)
        .map((match) => match[0]),
      ...[...code.matchAll(ARBITRARY_NAMED)]
        .filter((match) => NAMED_COLOURS.has((match[1] ?? '').toLowerCase()))
        .map((match) => match[0]),
      // A stylesheet's own declarations, unquoted (in code, `color: red` would be a variable).
      ...(css
        ? [...code.matchAll(CSS_DECLARATION)]
            .filter((match) => namedColoursIn(match[2] ?? '').length > 0)
            .map((match) => match[0].trim())
        : []),
    ],
  };
}

export interface FileReport extends RawColours {
  /** Relative to `apps/web`, with `/`. */
  readonly file: string;
}

function isScanned(file: string): boolean {
  if (!/\.(?:[cm]?[jt]sx?|css)$/.test(file)) return false;
  if (/\.test\.[cm]?[jt]sx?$/.test(file) || file.startsWith('src/test/')) return false;
  return !(TOKEN_FILES as readonly string[]).includes(file);
}

/** Every scanned file under `<root>/apps/web/src` with at least one raw colour, most first. */
export function scan(root: string, palettes: readonly string[] = repoPalettes()): FileReport[] {
  const web = join(root, 'apps/web');
  const reports: FileReport[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const file = relative(web, path).split(sep).join('/');
      if (!entry.isFile() || !isScanned(file)) continue;
      const found = rawColours(readFileSync(path, 'utf8'), palettes, {
        css: file.endsWith('.css'),
      });
      if (found.classes.length + found.hexes.length + found.values.length > 0) {
        reports.push({ file, ...found });
      }
    }
  };
  walk(join(web, 'src'));
  const total = (report: FileReport) =>
    report.classes.length + report.hexes.length + report.values.length;
  return reports.sort((a, b) => total(b) - total(a) || a.file.localeCompare(b.file));
}

/** The report as printed: one line per file (classes, hex, values, file), then the totals. */
export function formatReport(reports: readonly FileReport[]): string {
  const sum = (pick: (report: FileReport) => readonly string[]) =>
    reports.reduce((n, report) => n + pick(report).length, 0);
  const row = (a: number | string, b: number | string, c: number | string, file: string) =>
    `${String(a).padStart(7)} ${String(b).padStart(5)} ${String(c).padStart(6)}  ${file}`;
  return [
    'check-ui-tokens: raw colours in apps/web/src (none allowed; design system section 8)',
    row('classes', 'hex', 'values', 'file'),
    ...reports.map((report) =>
      row(report.classes.length, report.hexes.length, report.values.length, report.file),
    ),
    row(
      sum((r) => r.classes),
      sum((r) => r.hexes),
      sum((r) => r.values),
      `total in ${String(reports.length)} files`,
    ),
  ].join('\n');
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? REPO);
  // The palettes of this repository's Tailwind, also for a tree given as an argument.
  const reports = scan(root);
  if (reports.length === 0) {
    console.log('check-ui-tokens: no raw colour in apps/web/src');
  } else {
    console.error(formatReport(reports));
    console.error(
      'check-ui-tokens: use the semantic tokens (bg-surface, text-ink, border-alarm-border …) ' +
        'instead; raw values belong in src/index.css and src/components/ui/tokens.ts only',
    );
    process.exitCode = 1;
  }
}
