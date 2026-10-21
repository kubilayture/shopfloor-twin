/**
 * Checks the views of `docs/architecture.md` against the code (#280, P10-05; Phase 10 plan,
 * "Architecture views"). It runs in `pnpm verify`, so a view that no longer matches the code fails
 * the merge gate.
 *
 * The views are read from the document's Mermaid blocks by their node ids. A checked element has
 * an id with a prefix:
 *
 * - `svc_<service>`: a Compose service (`-` written `_`), from `docker-compose.yml` and
 *   `compose.observability.yml`;
 * - `vol_<volume>`: a named Compose volume of those files;
 * - `mod_<module>`: a module folder of `apps/mes-server/src/modules`;
 * - `pkg_<package>`: a workspace package `@shopfloor/<package>` (the folders `pnpm-workspace.yaml`
 *   names, `dir/*` expanded; another pattern fails the check).
 *
 * The Compose overlays (`compose.dev-ports.yml`, `compose.demo.yml`, `e2e/compose.*.yml`) may only
 * change services of the two files above: a service only an overlay defines fails the check.
 *
 * Every prefixed id in any Mermaid block (flowchart nodes, subgraphs, sequence participants) must
 * name something that exists, and in a flowchart must have a node of its own (`svc_db[("db …")]`),
 * not only appear in edges (Mermaid would draw a bare box for it). A block preceded by `<!-- architecture-check: <view> -->` is checked
 * further, and each of these views must be present exactly once:
 *
 * - `containers`: its services equal the services of `docker-compose.yml`, both directions;
 * - `observability`: it shows every service of `compose.observability.yml` (and may show the
 *   services it scrapes);
 * - `deployment`: its volumes equal the named volumes of both Compose files;
 * - `mes-components`: its modules equal the module folders, and its module-to-module edges equal
 *   the cross-module imports found in the modules' source (tests and test support excluded);
 * - `packages`: its packages equal the workspace packages; its solid edges (`-->`) equal the
 *   `dependencies` on workspace packages and its dotted edges (`-.->`) the `devDependencies`,
 *   except development dependencies on the tooling packages (`TOOLING`), which every workspace
 *   has and the view leaves out.
 *
 * Known limits (a guard, not a Mermaid or YAML implementation): flowchart lines are parsed in the
 * subset the document uses (one statement per line, node text in brackets, edge labels between
 * `|`), and a line it can't read fails the check rather than being skipped; the Compose files are
 * read by indentation (Prettier keeps them at two spaces), so a flow-style `services: {...}` would
 * show as no services and fail; networks, ports and edge labels are prose, reviewed by hand.
 *
 * Usage: node scripts/check-architecture.ts [repository root]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Compose files whose services and volumes the views show. */
export const COMPOSE_FILES = ['docker-compose.yml', 'compose.observability.yml'] as const;

/** Workspace packages that are development dependencies of nearly every workspace: not drawn. */
export const TOOLING = ['eslint-config', 'tsconfig', 'fc-seed'] as const;

/** The views checked beyond their ids, each marked once in the document. */
export const VIEWS = [
  'containers',
  'observability',
  'deployment',
  'mes-components',
  'packages',
] as const;
export type View = (typeof VIEWS)[number];

export type ArrowKind = 'solid' | 'dotted' | 'thick' | 'open';

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly kind: ArrowKind;
}

export interface MermaidBlock {
  /** 1-based line of the opening fence. */
  readonly line: number;
  readonly view: string | undefined;
  readonly source: string;
}

export interface Diagram {
  readonly ids: ReadonlySet<string>;
  /** Ids given a node of their own (a shape with text, a subgraph, a participant). */
  readonly defined: ReadonlySet<string>;
  readonly edges: readonly Edge[];
  readonly problems: readonly string[];
}

export interface WorkspacePackage {
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
}

/** What the code says, read by `readFacts`. */
export interface Facts {
  /** Services per Compose file. */
  readonly services: Readonly<Record<string, readonly string[]>>;
  /** Named volumes of all Compose files. */
  readonly volumes: readonly string[];
  readonly modules: readonly string[];
  /** Cross-module imports as `from>to`. */
  readonly moduleImports: readonly string[];
  /** Workspace packages by short name (`mes-server`), with their workspace dependencies. */
  readonly packages: Readonly<Record<string, WorkspacePackage>>;
  /** Services named by each Compose overlay (`compose.dev-ports.yml`, `e2e/compose.*.yml`, …). */
  readonly overlays: Readonly<Record<string, readonly string[]>>;
  /** What the reading itself could not make sense of (an unexpandable workspace pattern). */
  readonly readProblems: readonly string[];
}

const MARKER = /^<!--\s*architecture-check:\s*([a-z-]+)\s*-->$/;

/** The Mermaid blocks of a Markdown document, each with the view marked just before it. */
export function mermaidBlocks(markdown: string): MermaidBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: MermaidBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^```mermaid\s*$/.test(lines[i] ?? '')) continue;
    let view: string | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const before = (lines[j] ?? '').trim();
      if (before === '') continue;
      view = MARKER.exec(before)?.[1];
      break;
    }
    const body: string[] = [];
    let k = i + 1;
    for (; k < lines.length && !/^```\s*$/.test(lines[k] ?? ''); k++) body.push(lines[k] ?? '');
    blocks.push({ line: i + 1, view, source: body.join('\n') });
    i = k;
  }
  return blocks;
}

const ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const ARROWS: readonly (readonly [RegExp, ArrowKind])[] = [
  [/^<?-\.+->$/, 'dotted'],
  [/^<?=+>$/, 'thick'],
  [/^<?-{2,}>$/, 'solid'],
  [/^-{3,}$/, 'open'],
  [/^-\.+-$/, 'open'],
];
const ARROW_TOKEN = /(<?-\.+->|-\.+-|<?=+>|<?-{2,}>|-{3,})/;
const IGNORED = /^(flowchart|graph|end|classDef|class|style|linkStyle|direction|click)\b/;
/** An id followed by a shape (`id["text"]`, `id[("text")]`, `id(["text"])`, …): its node. */
const NODE_DEFINITION = /(?:^|[\s&>-])([A-Za-z][A-Za-z0-9_]*)(?=\s*[[({])/g;

function arrowKind(token: string): ArrowKind | undefined {
  return ARROWS.find(([pattern]) => pattern.test(token))?.[1];
}

/** Removes node text, edge labels and class shorthands, leaving ids, `&` and arrows. */
function bareStatement(line: string): string {
  let text = line.replace(/"[^"]*"/g, '""').replace(/\|[^|]*\|/g, ' ');
  for (let before = ''; before !== text;) {
    before = text;
    text = text.replace(/\[[^[\]]*\]|\([^()]*\)|\{[^{}]*\}/g, '');
  }
  return text.replace(/:::[A-Za-z0-9_-]+/g, '').trim();
}

/** The node ids and edges of a Mermaid flowchart, in the subset `docs/architecture.md` uses. */
export function parseFlowchart(source: string): Diagram {
  const ids = new Set<string>();
  const defined = new Set<string>();
  const edges: Edge[] = [];
  const problems: string[] = [];
  source.split('\n').forEach((raw, index) => {
    const line = raw.replace(/%%.*$/, '').trim();
    if (line === '' || IGNORED.test(line)) return;
    const subgraph = /^subgraph\s+([^\s[]+)/.exec(line);
    if (subgraph) {
      const id = subgraph[1] ?? '';
      if (ID.test(id)) {
        ids.add(id);
        defined.add(id);
      } else problems.push(`line ${String(index + 1)}: subgraph id ${id} unreadable`);
      return;
    }
    const unlabelled = line.replace(/"[^"]*"/g, '""').replace(/\|[^|]*\|/g, ' ');
    for (const match of unlabelled.matchAll(NODE_DEFINITION)) {
      if (match[1] !== undefined) defined.add(match[1]);
    }
    const parts = bareStatement(line)
      .split(ARROW_TOKEN)
      .map((part) => part.trim());
    const groups: string[][] = [];
    const kinds: ArrowKind[] = [];
    let readable = true;
    for (const [at, part] of parts.entries()) {
      if (at % 2 === 1) {
        const kind = arrowKind(part);
        if (kind === undefined) readable = false;
        else kinds.push(kind);
        continue;
      }
      const group = part.split('&').map((id) => id.trim());
      if (group.some((id) => !ID.test(id))) readable = false;
      groups.push(group);
    }
    if (!readable) {
      problems.push(`line ${String(index + 1)}: cannot read "${raw.trim()}"`);
      return;
    }
    for (const group of groups) for (const id of group) ids.add(id);
    kinds.forEach((kind, at) => {
      for (const from of groups[at] ?? []) {
        for (const to of groups[at + 1] ?? []) edges.push({ from, to, kind });
      }
    });
  });
  return { ids, defined, edges, problems };
}

const SEQUENCE_MESSAGE =
  /^([A-Za-z][A-Za-z0-9_]*)\s*(?:<<-{1,2}>>|-{1,2}>>|-{1,2}>|-{1,2}x|-{1,2}\))[+-]?\s*([A-Za-z][A-Za-z0-9_]*)\s*:/;
const SEQUENCE_NOTE = /^note\s+(?:over|left of|right of)\s+([^:]+):/i;

/**
 * The participants of a Mermaid sequence diagram: declared ones (`participant`, `actor`, also
 * after `create`), every message's ends and every id a note names.
 */
export function parseSequence(source: string): Diagram {
  const ids = new Set<string>();
  for (const raw of source.split('\n')) {
    const line = raw.replace(/%%.*$/, '').trim();
    const declared = /^(?:create\s+)?(?:participant|actor)\s+([A-Za-z][A-Za-z0-9_]*)/.exec(line);
    if (declared?.[1] !== undefined) ids.add(declared[1]);
    const note = SEQUENCE_NOTE.exec(line);
    for (const id of note?.[1]?.split(',') ?? []) ids.add(id.trim());
    const message = SEQUENCE_MESSAGE.exec(line);
    if (message?.[1] !== undefined && message[2] !== undefined) {
      ids.add(message[1]);
      ids.add(message[2]);
    }
  }
  return { ids, defined: ids, edges: [], problems: [] };
}

export function parseDiagram(source: string): Diagram {
  const first = source.trim().split('\n')[0]?.trim() ?? '';
  if (/^sequenceDiagram\b/.test(first)) return parseSequence(source);
  if (/^(flowchart|graph)\b/.test(first)) return parseFlowchart(source);
  return {
    ids: new Set(),
    defined: new Set(),
    edges: [],
    problems: [`unsupported diagram type "${first}"`],
  };
}

const toId = (prefix: string, name: string): string => `${prefix}_${name.replaceAll('-', '_')}`;
const ofPrefix = (ids: ReadonlySet<string>, prefix: string): Set<string> =>
  new Set([...ids].filter((id) => id.startsWith(`${prefix}_`)));

function difference(
  what: string,
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>,
  where: string,
): string[] {
  const missing = [...expected].filter((item) => !actual.has(item)).sort();
  const extra = [...actual].filter((item) => !expected.has(item)).sort();
  return [
    ...missing.map((item) => `${where}: ${what} ${item} is missing (it exists in the code)`),
    ...extra.map((item) => `${where}: ${what} ${item} is not in the code`),
  ];
}

/** Every drift between the document and the facts; empty when the views are true. */
export function checkArchitecture(markdown: string, facts: Facts): string[] {
  const problems: string[] = [];
  const allServices = new Set(
    Object.values(facts.services)
      .flat()
      .map((s) => toId('svc', s)),
  );
  const known: Readonly<Record<string, ReadonlySet<string>>> = {
    svc: allServices,
    vol: new Set(facts.volumes.map((v) => toId('vol', v))),
    mod: new Set(facts.modules.map((m) => toId('mod', m))),
    pkg: new Set(Object.keys(facts.packages).map((p) => toId('pkg', p))),
  };
  const blocks = mermaidBlocks(markdown);
  const seen = new Map<string, number>();
  for (const block of blocks) {
    const where = `docs/architecture.md:${String(block.line)}${block.view ? ` (${block.view})` : ''}`;
    const diagram = parseDiagram(block.source);
    problems.push(...diagram.problems.map((problem) => `${where}: ${problem}`));
    for (const id of diagram.ids) {
      const prefix = /^(svc|vol|mod|pkg)_/.exec(id)?.[1];
      if (prefix === undefined) continue;
      if (!known[prefix]?.has(id)) problems.push(`${where}: ${id} names nothing in the code`);
      if (!diagram.defined.has(id)) {
        problems.push(`${where}: ${id} appears only in edges (give it a node with its text)`);
      }
    }
    if (block.view === undefined) continue;
    if (!(VIEWS as readonly string[]).includes(block.view)) {
      problems.push(`${where}: unknown view "${block.view}" (known: ${VIEWS.join(', ')})`);
      continue;
    }
    seen.set(block.view, (seen.get(block.view) ?? 0) + 1);
    problems.push(...checkView(block.view as View, diagram, facts, where));
  }
  for (const view of VIEWS) {
    const count = seen.get(view) ?? 0;
    if (count !== 1) {
      problems.push(
        `docs/architecture.md: the view "${view}" is marked ${String(count)} times (needs exactly 1)`,
      );
    }
  }
  return problems;
}

function checkView(view: View, diagram: Diagram, facts: Facts, where: string): string[] {
  switch (view) {
    case 'containers': {
      const expected = new Set(
        (facts.services['docker-compose.yml'] ?? []).map((s) => toId('svc', s)),
      );
      return difference('service', expected, ofPrefix(diagram.defined, 'svc'), where);
    }
    case 'observability': {
      const shown = ofPrefix(diagram.defined, 'svc');
      return (facts.services['compose.observability.yml'] ?? [])
        .map((s) => toId('svc', s))
        .filter((id) => !shown.has(id))
        .map((id) => `${where}: service ${id} is missing (it exists in the code)`);
    }
    case 'deployment': {
      const expected = new Set(facts.volumes.map((v) => toId('vol', v)));
      return difference('volume', expected, ofPrefix(diagram.defined, 'vol'), where);
    }
    case 'mes-components': {
      const expected = new Set(facts.modules.map((m) => toId('mod', m)));
      const edges = new Set(
        facts.moduleImports.map((pair) => {
          const [from = '', to = ''] = pair.split('>');
          return `${toId('mod', from)} --> ${toId('mod', to)}`;
        }),
      );
      const drawn = new Set(
        diagram.edges
          .filter((e) => e.from.startsWith('mod_') && e.to.startsWith('mod_'))
          .map((e) => `${e.from} ${e.kind === 'solid' ? '-->' : `(${e.kind})`} ${e.to}`),
      );
      return [
        ...difference('module', expected, ofPrefix(diagram.defined, 'mod'), where),
        ...difference('import edge', edges, drawn, where),
      ];
    }
    case 'packages': {
      const expected = new Set(Object.keys(facts.packages).map((p) => toId('pkg', p)));
      const tooling = new Set<string>(TOOLING);
      const edges = new Set<string>();
      for (const [name, pkg] of Object.entries(facts.packages)) {
        for (const dep of pkg.dependencies)
          edges.add(`${toId('pkg', name)} --> ${toId('pkg', dep)}`);
        for (const dep of pkg.devDependencies) {
          if (!tooling.has(dep)) edges.add(`${toId('pkg', name)} -.-> ${toId('pkg', dep)}`);
        }
      }
      const drawn = new Set(
        diagram.edges
          .filter((e) => e.from.startsWith('pkg_') && e.to.startsWith('pkg_'))
          .map(
            (e) =>
              `${e.from} ${e.kind === 'dotted' ? '-.->' : e.kind === 'solid' ? '-->' : `(${e.kind})`} ${e.to}`,
          ),
      );
      return [
        ...difference('package', expected, ofPrefix(diagram.defined, 'pkg'), where),
        ...difference('dependency edge', edges, drawn, where),
      ];
    }
  }
}

/** The keys of a top-level YAML mapping (`services:`, `volumes:`) read by indentation. */
export function topLevelKeys(yaml: string, section: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${section}:\\s*(#.*)?$`).test(line));
  if (start < 0) return [];
  const keys: string[] = [];
  let indent: number | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const width = line.length - line.trimStart().length;
    indent ??= width;
    if (width !== indent) continue;
    const key = /^\s*(['"]?)([A-Za-z0-9._-]+)\1:(\s.*|$)/.exec(line)?.[2];
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

/** The items of a top-level YAML list (`packages:` of `pnpm-workspace.yaml`), unquoted. */
export function topLevelList(yaml: string, section: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${section}:\\s*(#.*)?$`).test(line));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const item = /^\s*-\s+(['"]?)([^'"#]+?)\1\s*(#.*)?$/.exec(line)?.[2];
    if (item !== undefined) items.push(item);
  }
  return items;
}

/**
 * The workspace folders named by `pnpm-workspace.yaml`: a plain folder, or `dir/*` for every
 * folder in it. Any other pattern is a problem (the check would not know which folders it names).
 */
export function workspaceFolders(
  root: string,
  globs: readonly string[],
): { folders: string[]; problems: string[] } {
  const folders: string[] = [];
  const problems: string[] = [];
  if (globs.length === 0) problems.push('pnpm-workspace.yaml: no packages read');
  for (const glob of globs) {
    if (/^[A-Za-z0-9._-]+\/\*$/.test(glob)) {
      const dir = glob.slice(0, -2);
      if (!existsSync(join(root, dir))) continue;
      for (const name of readdirSync(join(root, dir)).sort()) {
        if (statSync(join(root, dir, name)).isDirectory()) folders.push(`${dir}/${name}`);
      }
    } else if (/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(glob)) {
      folders.push(glob);
    } else {
      problems.push(`pnpm-workspace.yaml: the pattern ${glob} is not one the check can expand`);
    }
  }
  return { folders, problems };
}

/** Compose overlays: each may only change services the base and observability files define. */
export const OVERLAY_FILES = ['compose.dev-ports.yml', 'compose.demo.yml'] as const;

const SKIP_SOURCE = /\.test\.ts$|test-support\.ts$/;
const SPECIFIER = /\b(?:from|import)\s*\(?\s*(['"])([^'"]+)\1/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !SKIP_SOURCE.test(name) ? [path] : [];
  });
}

/** Cross-module imports (`from>to`) of the MES's modules, from their relative import specifiers. */
export function moduleImports(modulesDir: string): string[] {
  const pairs = new Set<string>();
  for (const module of readdirSync(modulesDir)) {
    const dir = join(modulesDir, module);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of sourceFiles(dir)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const match of code.matchAll(SPECIFIER)) {
        const specifier = match[2] ?? '';
        if (!specifier.startsWith('.')) continue;
        const target = relative(modulesDir, resolve(dirname(file), specifier)).split(sep)[0];
        if (target === undefined || target === '..' || target === module) continue;
        if (target.startsWith('..')) continue;
        pairs.add(`${module}>${target}`);
      }
    }
  }
  return [...pairs].sort();
}

interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const workspaceDeps = (deps: Readonly<Record<string, string>> | undefined): string[] =>
  Object.entries(deps ?? {})
    .filter(([name, range]) => range.startsWith('workspace:') && name.startsWith('@shopfloor/'))
    .map(([name]) => name.slice('@shopfloor/'.length))
    .sort();

/** Reads the facts from a checkout. */
export function readFacts(root: string): Facts {
  const services: Record<string, readonly string[]> = {};
  const volumes = new Set<string>();
  for (const file of COMPOSE_FILES) {
    const yaml = readFileSync(join(root, file), 'utf8');
    services[file] = topLevelKeys(yaml, 'services');
    for (const volume of topLevelKeys(yaml, 'volumes')) volumes.add(volume);
  }
  const modulesDir = join(root, 'apps/mes-server/src/modules');
  const modules = readdirSync(modulesDir)
    .filter((name) => statSync(join(modulesDir, name)).isDirectory())
    .sort();
  const overlays: Record<string, readonly string[]> = {};
  const overlayFiles = [
    ...OVERLAY_FILES,
    ...(existsSync(join(root, 'e2e'))
      ? readdirSync(join(root, 'e2e'))
          .filter((name) => /^compose\..*\.ya?ml$/.test(name))
          .sort()
          .map((name) => `e2e/${name}`)
      : []),
  ];
  for (const file of overlayFiles) {
    if (existsSync(join(root, file))) {
      overlays[file] = topLevelKeys(readFileSync(join(root, file), 'utf8'), 'services');
    }
  }
  const packages: Record<string, WorkspacePackage> = {};
  const workspaceFile = join(root, 'pnpm-workspace.yaml');
  const { folders, problems: readProblems } = workspaceFolders(
    root,
    existsSync(workspaceFile) ? topLevelList(readFileSync(workspaceFile, 'utf8'), 'packages') : [],
  );
  for (const folder of folders) {
    const file = join(root, folder, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    if (!manifest.name.startsWith('@shopfloor/')) continue;
    packages[manifest.name.slice('@shopfloor/'.length)] = {
      dependencies: workspaceDeps(manifest.dependencies),
      devDependencies: workspaceDeps(manifest.devDependencies),
    };
  }
  return {
    services,
    volumes: [...volumes].sort(),
    modules,
    moduleImports: moduleImports(modulesDir),
    packages,
    overlays,
    readProblems,
  };
}

/** Facts too thin to compare against mean the reading broke, not that the views are right. */
export function factProblems(facts: Facts): string[] {
  const problems: string[] = [];
  for (const file of COMPOSE_FILES) {
    if ((facts.services[file] ?? []).length === 0) problems.push(`${file}: no services read`);
  }
  if (facts.modules.length === 0) problems.push('apps/mes-server/src/modules: no modules read');
  if (Object.keys(facts.packages).length === 0) problems.push('no workspace packages read');
  problems.push(...facts.readProblems);
  const known = new Set(Object.values(facts.services).flat());
  for (const [file, services] of Object.entries(facts.overlays)) {
    for (const service of services) {
      if (!known.has(service)) {
        problems.push(
          `${file}: service ${service} is in no file the views show (${COMPOSE_FILES.join(', ')})`,
        );
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));
  const facts = readFacts(root);
  const markdown = readFileSync(join(root, 'docs/architecture.md'), 'utf8');
  const problems = [...factProblems(facts), ...checkArchitecture(markdown, facts)];
  if (problems.length > 0) {
    console.error(
      `check-architecture: docs/architecture.md and the code disagree (${String(problems.length)}):`,
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('Update the views (or the code) so both say the same; see the script header.');
    process.exit(1);
  }
  const services = Object.values(facts.services).flat().length;
  const packageEdges = Object.values(facts.packages).reduce(
    (sum, pkg) =>
      sum +
      pkg.dependencies.length +
      pkg.devDependencies.filter((d) => !(TOOLING as readonly string[]).includes(d)).length,
    0,
  );
  console.log(
    `check-architecture: OK (${String(services)} services, ${String(facts.volumes.length)} volumes, ` +
      `${String(facts.modules.length)} modules with ${String(facts.moduleImports.length)} import edges, ` +
      `${String(Object.keys(facts.packages).length)} packages with ${String(packageEdges)} dependency edges)`,
  );
}
