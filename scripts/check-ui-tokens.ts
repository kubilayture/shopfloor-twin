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
 * Comments are left out (an issue number such as `#145` would read as a colour). Known limits (a
 * report, not a parser): a class is found wherever its text appears in the code, strings
 * included; one built at run time from pieces (`bg-${tone}-700`) is not; an apostrophe in JSX
 * text can hide a comment from the comment filter; `rgb()` and `oklch()` values are not counted.
 *
 * Usage: node scripts/check-ui-tokens.ts [repository root]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Tailwind's colour palettes (v4), each with steps 50 to 950; `neutral` also has our `neutral-0`. */
export const PALETTES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
] as const;

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
const CLASS = new RegExp(
  String.raw`(?<![\w-])(?:[\w-]+:)*(?:${COLOUR_UTILITIES.join('|')})-` +
    String.raw`(?:(?:${PALETTES.join('|')})-(?:0|50|[1-9]00|950)|white|black)(?:\/[\w.]+)?(?![\w-])`,
  'g',
);

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; not an HTML entity (`&#123;`) or a longer word. */
const HEX = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

/** Files under `apps/web/src` that hold the tokens' raw values on purpose. */
export const TOKEN_FILES = ['src/index.css', 'src/components/ui/tokens.ts'] as const;

export interface RawColours {
  readonly classes: readonly string[];
  readonly hexes: readonly string[];
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

/** The raw palette classes and hex colours in one file's code, in order of appearance. */
export function rawColours(source: string): RawColours {
  const code = withoutComments(source);
  return {
    classes: [...code.matchAll(CLASS)].map((match) => match[0]),
    hexes: [...code.matchAll(HEX)].map((match) => match[0]),
  };
}

export interface FileReport extends RawColours {
  /** Relative to `apps/web`, with `/`. */
  readonly file: string;
}

function isScanned(file: string): boolean {
  if (!/\.(tsx?|css)$/.test(file)) return false;
  if (/\.test\.tsx?$/.test(file) || file.startsWith('src/test/')) return false;
  return !(TOKEN_FILES as readonly string[]).includes(file);
}

/** Every scanned file under `<root>/apps/web/src` with at least one raw colour, most first. */
export function scan(root: string): FileReport[] {
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
      const found = rawColours(readFileSync(path, 'utf8'));
      if (found.classes.length + found.hexes.length > 0) reports.push({ file, ...found });
    }
  };
  walk(join(web, 'src'));
  const total = (report: FileReport) => report.classes.length + report.hexes.length;
  return reports.sort((a, b) => total(b) - total(a) || a.file.localeCompare(b.file));
}

/** The report as printed: one line per file (classes, hex, file), then the totals. */
export function formatReport(reports: readonly FileReport[]): string {
  const classes = reports.reduce((sum, report) => sum + report.classes.length, 0);
  const hexes = reports.reduce((sum, report) => sum + report.hexes.length, 0);
  const row = (a: number | string, b: number | string, file: string) =>
    `${String(a).padStart(7)} ${String(b).padStart(5)}  ${file}`;
  return [
    'check-ui-tokens: raw colours in apps/web/src (none allowed; design system section 8)',
    row('classes', 'hex', 'file'),
    ...reports.map((report) => row(report.classes.length, report.hexes.length, report.file)),
    row(classes, hexes, `total in ${String(reports.length)} files`),
  ].join('\n');
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));
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
