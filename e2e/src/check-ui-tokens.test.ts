import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatReport, rawColours, scan, withoutComments } from '../../scripts/check-ui-tokens.ts';

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
    const source = `<div className="bg-slate-50 hover:bg-sky-100 md:focus-visible:outline-sky-700 border-t-red-700/40 text-white print:bg-black ring-offset-amber-950 divide-zinc-200" />`;
    expect(rawColours(source).classes).toEqual([
      'bg-slate-50',
      'hover:bg-sky-100',
      'md:focus-visible:outline-sky-700',
      'border-t-red-700/40',
      'text-white',
      'print:bg-black',
      'ring-offset-amber-950',
      'divide-zinc-200',
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

  it('drops comments but keeps strings that hold comment markers', () => {
    expect(withoutComments(`a // b\nc /* d */ e '//f' "/*g*/"`)).toBe(`a \nc  e '//f' "/*g*/"`);
  });
});

describe('scan and formatReport', () => {
  it('reports each file with raw colours, most first, and skips the token files and tests', () => {
    const root = webTree({
      'src/screens/a.tsx': `<p className="bg-slate-50 text-white">'#ffffff'</p>`,
      'src/screens/b.tsx': `<p className="bg-red-700" />`,
      'src/chart/c.ts': `const x = '#0369a1';`,
      'src/clean.tsx': `<p className="bg-surface text-ink" />`,
      'src/index.css': `@theme { --color-surface: #ffffff; }`,
      'src/components/ui/tokens.ts': `color('surface', '#ffffff')`,
      'src/screens/a.test.tsx': `'bg-slate-50 #ffffff'`,
      'src/test/fixtures.ts': `'#ffffff'`,
      'src/notes.md': `bg-slate-50`,
    });
    const reports = scan(root);
    expect(reports).toEqual([
      { file: 'src/screens/a.tsx', classes: ['bg-slate-50', 'text-white'], hexes: ['#ffffff'] },
      { file: 'src/chart/c.ts', classes: [], hexes: ['#0369a1'] },
      { file: 'src/screens/b.tsx', classes: ['bg-red-700'], hexes: [] },
    ]);
    expect(formatReport(reports).split('\n')).toEqual([
      'check-ui-tokens: raw colours in apps/web/src (report only; design system section 8)',
      'classes   hex  file',
      '      2     1  src/screens/a.tsx',
      '      0     1  src/chart/c.ts',
      '      1     0  src/screens/b.tsx',
      '      3     2  total in 3 files',
    ]);
  });

  it('runs as a report that always exits 0, on the repository and on a tree full of raw colours', () => {
    const repo = spawnSync(process.execPath, [join(REPO, 'scripts/check-ui-tokens.ts'), REPO], {
      encoding: 'utf8',
    });
    expect(repo.status, repo.stderr).toBe(0);
    expect(repo.stdout).toMatch(/^check-ui-tokens: raw colours in apps\/web\/src/);
    expect(repo.stdout).toMatch(/\d+ +\d+ {2}total in \d+ files\n$/);
    expect(repo.stdout).not.toContain('src/index.css');

    const root = webTree({ 'src/a.tsx': `"bg-slate-50 '#000000'"` });
    const raw = spawnSync(process.execPath, [join(REPO, 'scripts/check-ui-tokens.ts'), root], {
      encoding: 'utf8',
    });
    expect(raw.status, raw.stderr).toBe(0);
    expect(raw.stdout).toContain('      1     1  src/a.tsx');
  });
});
