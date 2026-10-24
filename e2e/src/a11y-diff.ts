/**
 * The before/after diff of two harness reports (UX-1g, #321): `pnpm a11y:diff <before.json>
 * <after.json> [out.md]` from the repository root. Narrowed by the same `A11Y_ROUTES` (route ids
 * or path prefixes), `A11Y_ROLES`, `A11Y_WIDTHS` and `A11Y_STATES` as the run, so a screen's pull
 * request compares only its routes. Prints the markdown (and writes it to `out.md` when given).
 * Light: no stack.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { ROUTES } from '../browser/a11y/routes.ts';
import { diffMarkdown, filterFromEnv, routeSelected, type A11yReport } from './a11y-report.ts';

const [beforePath, afterPath, outPath] = process.argv.slice(2);
if (beforePath === undefined || afterPath === undefined) {
  console.error('usage: a11y:diff <before report.json> <after report.json> [out.md]');
  process.exit(2);
}
const filter = filterFromEnv(process.env);
// Path prefixes (`/orders`) become the ids of the routes they select, as in the run.
const routes =
  filter.routes.length === 0
    ? []
    : ROUTES.filter((r) => routeSelected(filter, r.id, r.path)).map((r) => r.id);
if (filter.routes.length > 0 && routes.length === 0) {
  console.error(`A11Y_ROUTES selects no route: ${filter.routes.join(', ')}`);
  process.exit(2);
}
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as A11yReport;
const markdown = diffMarkdown(await read(beforePath), await read(afterPath), {
  ...filter,
  routes,
});
if (outPath !== undefined) await writeFile(outPath, markdown);
console.log(markdown);
