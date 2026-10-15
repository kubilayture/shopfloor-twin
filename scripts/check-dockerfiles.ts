/**
 * Checks each app's Dockerfile against the workspace dependency graph (#99).
 *
 * The images install with `pnpm install --filter <app>...` from copied `package.json` files and
 * then copy the sources package by package. A workspace package missing from those lists breaks
 * the image only when it runs (#94 shipped a simulator image without `shift-calendar`), so this
 * check runs in `pnpm verify`:
 *
 * - every workspace package the install selects (production dependencies with `--prod`, all
 *   dependencies otherwise, transitively) has its `package.json` copied;
 * - every workspace package the app needs at run time (production dependencies, transitively) has
 *   its `src` copied;
 * - nothing else from `apps/` or `packages/` is copied, so the lists don't keep stale entries.
 *
 * Known limits (the check is a guard, not a Dockerfile parser): a broad `COPY packages packages`
 * passes; only `package.json` and `src` are checked (not, for example, `packages/tsconfig/base.json`
 * a build stage needs); stages are not told apart; JSON-form `COPY [...]` lines are not read, so
 * they show as missing (the safe direction).
 *
 * Usage: node scripts/check-dockerfiles.ts [repository root]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

interface WorkspacePackage {
  /** Directory relative to the root, for example `packages/contracts`. */
  readonly dir: string;
  readonly manifest: Manifest;
}

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));

function readWorkspace(): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(root, group))) {
      const file = join(root, group, name, 'package.json');
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
      packages.set(manifest.name, { dir: `${group}/${name}`, manifest });
    }
  }
  return packages;
}

/** The workspace packages `start` reaches through `workspace:` dependencies, `start` included. */
function closure(
  workspace: ReadonlyMap<string, WorkspacePackage>,
  start: string,
  withDev: boolean,
): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    const pkg = workspace.get(name);
    if (pkg === undefined || seen.has(name)) continue;
    seen.add(name);
    const deps = {
      ...pkg.manifest.dependencies,
      ...(withDev ? pkg.manifest.devDependencies : {}),
    };
    for (const [dep, range] of Object.entries(deps)) {
      if (range.startsWith('workspace:')) queue.push(dep);
    }
  }
  return seen;
}

/** Source paths of the `COPY` instructions that read from the build context. */
function contextCopies(dockerfile: string): string[] {
  // Join continuation lines, then take every COPY without --from=.
  const lines = dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const sources: string[] = [];
  for (const line of lines) {
    const words = line.trim().split(/\s+/);
    if (words[0]?.toUpperCase() !== 'COPY') continue;
    const args = words.slice(1).filter((word) => !word.startsWith('--'));
    if (words.some((word) => word.startsWith('--from='))) continue;
    sources.push(...args.slice(0, -1).map((path) => path.replace(/^\.\//, '').replace(/\/$/, '')));
  }
  return sources;
}

/** Whether `path` (a COPY source) brings in `target` (a file or directory of the context). */
const covers = (path: string, target: string): boolean =>
  path === target || target.startsWith(`${path}/`);

function checkDockerfile(
  workspace: ReadonlyMap<string, WorkspacePackage>,
  file: string,
  text: string,
): string[] {
  const filter = /--filter\s+(\S+?)\.\.\./.exec(text);
  if (filter?.[1] === undefined) return [`${file}: no \`pnpm install --filter <app>...\` found`];
  const app = filter[1];
  if (!workspace.has(app)) return [`${file}: --filter names ${app}, not a workspace package`];
  const prod = /pnpm install[^\n]*--prod/.test(text);
  const installed = closure(workspace, app, !prod);
  const runtime = closure(workspace, app, false);
  const copies = contextCopies(text);
  const problems: string[] = [];
  const copied = (target: string) => copies.some((path) => covers(path, target));
  for (const name of installed) {
    const { dir } = workspace.get(name) ?? { dir: '' };
    if (!copied(`${dir}/package.json`)) {
      problems.push(`${file}: COPY ${dir}/package.json is missing (${app} depends on ${name})`);
    }
  }
  for (const name of runtime) {
    const { dir } = workspace.get(name) ?? { dir: '' };
    if (!copied(`${dir}/src`)) {
      problems.push(`${file}: COPY ${dir}/src is missing (${app} needs ${name} at run time)`);
    }
  }
  const needed = new Set([...installed].map((name) => workspace.get(name)?.dir));
  for (const path of copies) {
    const match = /^((?:apps|packages)\/[^/]+)/.exec(path);
    if (match?.[1] !== undefined && !needed.has(match[1])) {
      problems.push(`${file}: COPY ${path}: ${app} does not depend on ${match[1]}`);
    }
  }
  return problems;
}

const workspace = readWorkspace();
const dockerfiles = [...workspace.values()]
  .map(({ dir }) => `${dir}/Dockerfile`)
  .filter((file) => existsSync(join(root, file)))
  .sort();
const problems = dockerfiles.flatMap((file) =>
  checkDockerfile(workspace, file, readFileSync(join(root, file), 'utf8')),
);
if (problems.length > 0) {
  console.error(
    `Dockerfile COPY lists don't match the workspace dependencies:\n  ${problems.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(`ok: ${dockerfiles.join(', ')} copy every workspace package they depend on`);
