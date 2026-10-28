import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatReport,
  namedColoursIn,
  palettesFrom,
  rawColours,
  scan,
  tailwindPalettes,
  withoutComments,
} from '../../scripts/check-ui-tokens.ts';

/** `scripts/check-ui-tokens.ts` (UX-1a, #314): the raw-colour report of the web app. */

const REPO = join(import.meta.dirname, '..', '..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function webTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-ui-tokens-'));
  dirs.push(root);
  for (const [file, text] of Object.entries(files)) {
    const path = join(root, 'apps/web', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

describe('rawColours', () => {
  it('finds palette classes with variants, opacity, sides, white and black', () => {
    const source = `<div className="bg-slate-50 hover:bg-sky-100 md:focus-visible:outline-sky-700 border-t-red-700/40 text-white print:bg-black ring-offset-amber-950 divide-zinc-200 bg-neutral-0" />`;
    expect(rawColours(source).classes).toEqual([
      'bg-slate-50',
      'hover:bg-sky-100',
      'md:focus-visible:outline-sky-700',
      'border-t-red-700/40',
      'text-white',
      'print:bg-black',
      'ring-offset-amber-950',
      'divide-zinc-200',
      'bg-neutral-0',
    ]);
  });

  it('leaves token classes and look-alikes alone', () => {
    const source = `"bg-surface text-ink border-alarm-border bg-neutral-soft text-neutral-ink bg-state-down-fill text-sm bg-slate text-slate-55 my-bg-slate-50 text-whitesmoke"`;
    expect(rawColours(source).classes).toEqual([]);
  });

  it('finds hex colours of 3, 4, 6 and 8 digits in code, not entities, ids or comments', () => {
    const source = [
      `const a = '#fff'; const b = "#b91c1cff"; const c = \`#0f172a\`; const d = '#abcd';`,
      `const href = '#main'; const entity = '&#123;'; const long = '#1234567';`,
      `// Alarm KPIs (#145) and #b91c1c in a comment`,
      `/* print (#146) */ const e = 'http://x/y';`,
    ].join('\n');
    expect(rawColours(source).hexes).toEqual(['#fff', '#b91c1cff', '#0f172a', '#abcd']);
  });

  it('knows every palette of the installed Tailwind, its newest included (#393 review F3)', () => {
    const palettes = tailwindPalettes(REPO);
    expect(palettes).toEqual(
      expect.arrayContaining(['slate', 'red', 'mauve', 'mist', 'olive', 'taupe']),
    );
    expect(
      rawColours('"bg-mauve-500 border-olive-300 text-mist-50 ring-taupe-950"').classes,
    ).toEqual(['bg-mauve-500', 'border-olive-300', 'text-mist-50', 'ring-taupe-950']);
    // Read from the theme: a palette a release adds is caught without a change here.
    expect(
      palettesFrom('@theme { --color-plum-50: x; --color-plum-950: y; --color-ink: z; }'),
    ).toEqual(['plum']);
    expect(rawColours('"bg-plum-500"', ['plum']).classes).toEqual(['bg-plum-500']);
  });

  it('finds colour functions with literal arguments and literal colour property values', () => {
    const source = [
      `<p className="text-[rgb(15_23_42)] bg-[oklch(0.6_0.2_30)]" />`,
      `const a = 'hsl(210 40% 98%)'; const b = \`rgba(\${r}, \${g}, 0, 1)\`;`,
      `<div style={{ color: 'red', backgroundColor: "teal", fill: 'currentColor' }} />`,
      `const ok = { color: 'transparent', stroke: 'none', background: 'var(--color-surface)' };`,
      `const hex = { borderColor: '#fff' };`,
    ].join('\n');
    expect(rawColours(source).values).toEqual([
      'rgb(1',
      'oklch(0',
      'hsl(2',
      "color: 'red'",
      'backgroundColor: "teal"',
    ]);
    // A hex value is counted once, as a hex.
    expect(rawColours(source).hexes).toEqual(['#fff']);
  });

  it('finds named colours in a stylesheet and in arbitrary classes, not in urls or templates (#393 re-review)', () => {
    const css = `.x { color: red; border: 1px solid navy; background: var(--color-surface); }\n.y { background-image: url(red.png); fill: context-fill; }`;
    expect(rawColours(css, undefined, { css: true }).values).toEqual([
      'color: red',
      'border: 1px solid navy',
    ]);
    // In code, an unquoted `color: red` is a variable, not a colour.
    expect(rawColours(`const style = { color: red };`).values).toEqual([]);
    expect(
      rawColours(
        `<p className="text-[red] bg-[color:blue] w-[calc(100%-1rem)] text-[length:12px]" />`,
      ).values,
    ).toEqual(['text-[red]', 'bg-[color:blue]']);
    const notColours = [
      `const a = { background: 'url(a.png)' };`,
      'const b = { borderColor: `${tone}` };',
      `const c = { fill: 'context-fill', stroke: 'context-stroke' };`,
    ].join('\n');
    expect(rawColours(notColours).values).toEqual([]);
    expect(namedColoursIn('1px solid navy')).toEqual(['navy']);
    expect(namedColoursIn('url(red.png) ${x}')).toEqual([]);
  });

  it('drops comments but keeps strings that hold comment markers', () => {
    expect(withoutComments(`a // b\nc /* d */ e '//f' "/*g*/"`)).toBe(`a \nc  e '//f' "/*g*/"`);
  });
});

describe('scan and formatReport', () => {
  it('reports each file with raw colours, most first, and skips the token files and tests', () => {
    const root = webTree({
      'src/styles/extra.css': `.x { color: red; }`,
      'src/screens/a.tsx': `<p className="bg-slate-50 text-white">'#ffffff'</p>`,
      'src/screens/b.tsx': `<p className="bg-red-700" />`,
      'src/chart/c.ts': `const x = '#0369a1';`,
      'src/clean.tsx': `<p className="bg-surface text-ink" />`,
      'src/index.css': `@theme { --color-surface: #ffffff; }`,
      'src/components/ui/tokens.ts': `color('surface', '#ffffff')`,
      'src/screens/a.test.tsx': `'bg-slate-50 #ffffff'`,
      'src/test/fixtures.ts': `'#ffffff'`,
      'src/notes.md': `bg-slate-50`,
      'src/legacy.jsx': `<p style={{ color: 'red' }} />`,
    });
    const reports = scan(root);
    expect(reports).toEqual([
      {
        file: 'src/screens/a.tsx',
        classes: ['bg-slate-50', 'text-white'],
        hexes: ['#ffffff'],
        values: [],
      },
      { file: 'src/chart/c.ts', classes: [], hexes: ['#0369a1'], values: [] },
      { file: 'src/legacy.jsx', classes: [], hexes: [], values: ["color: 'red'"] },
      { file: 'src/screens/b.tsx', classes: ['bg-red-700'], hexes: [], values: [] },
      { file: 'src/styles/extra.css', classes: [], hexes: [], values: ['color: red'] },
    ]);
    expect(formatReport(reports).split('\n')).toEqual([
      'check-ui-tokens: raw colours in apps/web/src (none allowed; design system section 8)',
      'classes   hex values  file',
      '      2     1      0  src/screens/a.tsx',
      '      0     1      0  src/chart/c.ts',
      '      0     0      1  src/legacy.jsx',
      '      1     0      0  src/screens/b.tsx',
      '      0     0      1  src/styles/extra.css',
      '      3     2      2  total in 5 files',
    ]);
  });

  it('passes on the repository, which has no raw colour left, and fails on one (UX-F3, #339)', () => {
    const repo = spawnSync(process.execPath, [join(REPO, 'scripts/check-ui-tokens.ts'), REPO], {
      encoding: 'utf8',
    });
    expect(repo.status, repo.stderr).toBe(0);
    expect(repo.stdout).toBe('check-ui-tokens: no raw colour in apps/web/src\n');

    const root = webTree({ 'src/a.tsx': `"bg-slate-50 '#000000'"` });
    const raw = spawnSync(process.execPath, [join(REPO, 'scripts/check-ui-tokens.ts'), root], {
      encoding: 'utf8',
    });
    expect(raw.status).toBe(1);
    expect(raw.stderr).toContain('      1     1      0  src/a.tsx');
    expect(raw.stderr).toContain('use the semantic tokens');
    expect(raw.stdout).toBe('');
  });
});
