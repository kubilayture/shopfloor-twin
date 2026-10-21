import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Facts,
  VIEWS,
  checkArchitecture,
  factProblems,
  mermaidBlocks,
  moduleImports,
  parseFlowchart,
  parseSequence,
  readFacts,
  topLevelKeys,
} from '../../scripts/check-architecture.ts';

/**
 * `scripts/check-architecture.ts` (#280, P10-05; Phase 10 plan "Architecture views"): the parser,
 * the reading of the code, and the check against the real `docs/architecture.md`, including the
 * drifts it must catch (an extra service, a service gone, a package missing, an import edge).
 */

const REPO = join(import.meta.dirname, '../..');
const DOC = readFileSync(join(REPO, 'docs/architecture.md'), 'utf8');
const FACTS = readFacts(REPO);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The document with one marked view's block changed by `edit`. */
function editView(view: string, edit: (source: string) => string): string {
  const marker = `<!-- architecture-check: ${view} -->`;
  const at = DOC.indexOf(marker);
  expect(at).toBeGreaterThan(0);
  const start = DOC.indexOf('```mermaid\n', at) + '```mermaid\n'.length;
  const end = DOC.indexOf('\n```', start);
  return DOC.slice(0, start) + edit(DOC.slice(start, end)) + DOC.slice(end);
}

/** Lines of a block without those mentioning `id` (its node and every edge to or from it). */
const withoutId = (id: string) => (source: string) =>
  source
    .split('\n')
    .filter((line) => !new RegExp(`\\b${id}\\b`).test(line))
    .join('\n');

describe('parseFlowchart', () => {
  it('reads nodes in every shape the document uses, with quoted text and labels', () => {
    const diagram = parseFlowchart(
      [
        'flowchart LR',
        '    a(["Person<br/>with (parens) and | pipes"])',
        '    b[("store: x [y]")]',
        '    subgraph group ["Group: z"]',
        '        c["c<br/>:4841-4845"]',
        '    end',
        '    a -->|"HTTPS 127.0.0.1:8443, dev CA"| b',
        '    b -.->|"files"| c',
        '    c ==> a',
        '    a --- c',
        '    %% a comment --> nowhere',
        '    classDef x stroke-dasharray: 5 5',
      ].join('\n'),
    );
    expect(diagram.problems).toEqual([]);
    expect([...diagram.ids].sort()).toEqual(['a', 'b', 'c', 'group']);
    expect(diagram.edges).toEqual([
      { from: 'a', to: 'b', kind: 'solid' },
      { from: 'b', to: 'c', kind: 'dotted' },
      { from: 'c', to: 'a', kind: 'thick' },
      { from: 'a', to: 'c', kind: 'open' },
    ]);
  });

  it('expands & groups and chains into every edge they stand for', () => {
    const diagram = parseFlowchart('flowchart TB\n  a & b --> c & d -.-> e');
    expect(diagram.edges.map((e) => `${e.from}${e.kind === 'solid' ? '>' : '~'}${e.to}`)).toEqual([
      'a>c',
      'a>d',
      'b>c',
      'b>d',
      'c~e',
      'd~e',
    ]);
  });

  it('reports a line it cannot read instead of skipping it', () => {
    const diagram = parseFlowchart('flowchart LR\n  a -- text --> b\n  c-d --> e');
    expect(diagram.problems).toHaveLength(2);
    expect(diagram.problems[0]).toMatch(/line 2: cannot read/);
  });
});

describe('parseSequence', () => {
  it('takes declared participants and both ends of every message', () => {
    const diagram = parseSequence(
      [
        'sequenceDiagram',
        '    participant svc_mes as mes',
        '    actor sup as supervisor',
        '    sup->>svc_mes: POST /orders/{id}/close',
        '    svc_mes-->>sup: 409',
        '    svc_mes--xsvc_ghost: lost',
        '    Note over svc_mes: not a participant',
      ].join('\n'),
    );
    expect([...diagram.ids].sort()).toEqual(['sup', 'svc_ghost', 'svc_mes']);
  });
});

describe('mermaidBlocks', () => {
  it('pairs each block with the marker just before it, blank lines allowed', () => {
    const blocks = mermaidBlocks(
      [
        'text',
        '<!-- architecture-check: containers -->',
        '',
        '```mermaid',
        'flowchart LR',
        '  a --> b',
        '```',
        '```mermaid',
        'sequenceDiagram',
        '```',
      ].join('\n'),
    );
    expect(blocks).toEqual([
      { line: 4, view: 'containers', source: 'flowchart LR\n  a --> b' },
      { line: 8, view: undefined, source: 'sequenceDiagram' },
    ]);
  });
});

describe('topLevelKeys', () => {
  it('reads the keys at the section’s own indentation only', () => {
    const yaml = [
      'name: x',
      'services:',
      '  # a comment',
      '  db:',
      '    image: postgres',
      '    volumes:',
      '      - db-data:/var/lib',
      '',
      '  opcua-tools: # profile tools',
      '    profiles: [tools]',
      'volumes:',
      '  db-data:',
      '  web-tls: {}',
    ].join('\n');
    expect(topLevelKeys(yaml, 'services')).toEqual(['db', 'opcua-tools']);
    expect(topLevelKeys(yaml, 'volumes')).toEqual(['db-data', 'web-tls']);
    expect(topLevelKeys(yaml, 'networks')).toEqual([]);
  });
});

describe('moduleImports', () => {
  it('finds relative imports into other modules, not tests, comments or its own files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-architecture-'));
    dirs.push(dir);
    for (const module of ['a', 'b', 'c', 'd']) mkdirSync(join(dir, module));
    mkdirSync(join(dir, 'a', 'nested'));
    writeFileSync(
      join(dir, 'a', 'a.ts'),
      [
        "import { B } from '../b/index.ts';",
        "import type { Own } from './own.ts';",
        "import { db } from '../../db/database.ts';",
        "// import { C } from '../c/index.ts';",
        "/* export { D } from '../d/index.ts'; */",
      ].join('\n'),
    );
    writeFileSync(join(dir, 'a', 'nested', 'deep.ts'), "export * from '../../d/index.ts';\n");
    writeFileSync(join(dir, 'a', 'a.test.ts'), "import { C } from '../c/index.ts';\n");
    writeFileSync(join(dir, 'a', 'test-support.ts'), "import { C } from '../c/index.ts';\n");
    writeFileSync(join(dir, 'b', 'index.ts'), "const m = await import('../c/c.ts');\n");
    expect(moduleImports(dir)).toEqual(['a>b', 'a>d', 'b>c']);
  });
});

describe('readFacts on this repository', () => {
  it('reads the Compose services and volumes, the modules and the packages', () => {
    expect(factProblems(FACTS)).toEqual([]);
    expect(FACTS.services['docker-compose.yml']).toEqual(
      expect.arrayContaining(['db', 'broker', 'pki', 'opcua-tools', 'migrate', 'mes', 'web']),
    );
    expect(FACTS.services['compose.observability.yml']).toEqual(['prometheus', 'grafana']);
    expect(FACTS.volumes).toEqual(expect.arrayContaining(['db-data', 'pki-ca', 'prometheus-data']));
    expect(FACTS.modules).toHaveLength(12);
    expect(FACTS.moduleImports).toEqual(expect.arrayContaining(['realtime>quality', 'oee>orders']));
    expect(FACTS.packages.e2e?.devDependencies).toEqual(
      expect.arrayContaining(['pki', 'test-kit']),
    );
    expect(FACTS.packages['trace-core']?.dependencies).toEqual(['spc-core']);
  });
});

describe('checkArchitecture against docs/architecture.md', () => {
  it('finds the document true to the code', () => {
    expect(checkArchitecture(DOC, FACTS)).toEqual([]);
  });

  it('marks every checked view exactly once', () => {
    const views = mermaidBlocks(DOC).flatMap((block) => (block.view ? [block.view] : []));
    expect(views.sort()).toEqual([...VIEWS].sort());
  });

  it('fails on a fake service added to the container view', () => {
    const doc = editView('containers', (s) => `${s}\n    svc_cache["cache<br/>Redis"]`);
    expect(checkArchitecture(doc, FACTS)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/svc_cache names nothing in the code/),
        expect.stringMatching(/\(containers\): service svc_cache is not in the code/),
      ]),
    );
  });

  it('fails on a service removed from the container view', () => {
    const doc = editView('containers', withoutId('svc_erp'));
    expect(checkArchitecture(doc, FACTS)).toEqual([
      expect.stringMatching(/\(containers\): service svc_erp is missing/),
    ]);
  });

  it('fails on a service removed from Compose that the views still show', () => {
    const facts: Facts = {
      ...FACTS,
      services: {
        ...FACTS.services,
        'docker-compose.yml': (FACTS.services['docker-compose.yml'] ?? []).filter(
          (s) => s !== 'opcua-tools',
        ),
      },
    };
    const problems = checkArchitecture(DOC, facts);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\(containers\): service svc_opcua_tools is not in the code/),
        expect.stringMatching(/svc_opcua_tools names nothing in the code/),
      ]),
    );
  });

  it('fails on a service added to Compose without a node', () => {
    const facts: Facts = {
      ...FACTS,
      services: {
        ...FACTS.services,
        'docker-compose.yml': [...(FACTS.services['docker-compose.yml'] ?? []), 'cache'],
      },
    };
    expect(checkArchitecture(DOC, facts)).toEqual([
      expect.stringMatching(/\(containers\): service svc_cache is missing/),
    ]);
  });

  it('fails on an observability service missing from its view', () => {
    const doc = editView('observability', withoutId('svc_grafana'));
    expect(checkArchitecture(doc, FACTS)).toEqual([
      expect.stringMatching(/\(observability\): service svc_grafana is missing/),
    ]);
  });

  it('fails on a package missing from the package view', () => {
    const doc = editView('packages', withoutId('pkg_fc_seed'));
    expect(checkArchitecture(doc, FACTS)).toEqual([
      expect.stringMatching(/\(packages\): package pkg_fc_seed is missing/),
    ]);
  });

  it('fails on a package of the workspace the view lacks, and on a dependency not drawn', () => {
    const facts: Facts = {
      ...FACTS,
      packages: {
        ...FACTS.packages,
        'report-kit': { dependencies: ['contracts'], devDependencies: ['tsconfig'] },
      },
    };
    expect(checkArchitecture(DOC, facts)).toEqual([
      expect.stringMatching(/package pkg_report_kit is missing/),
      expect.stringMatching(/dependency edge pkg_report_kit --> pkg_contracts is missing/),
    ]);
  });

  it('tells dependencies from development dependencies', () => {
    const doc = editView('packages', (s) =>
      s.replace(
        'pkg_e2e -.-> pkg_pki & pkg_test_kit',
        'pkg_e2e --> pkg_pki\n    pkg_e2e -.-> pkg_test_kit',
      ),
    );
    expect(checkArchitecture(doc, FACTS)).toEqual([
      expect.stringMatching(/dependency edge pkg_e2e -\.-> pkg_pki is missing/),
      expect.stringMatching(/dependency edge pkg_e2e --> pkg_pki is not in the code/),
    ]);
  });

  it('fails on a module import edge the code lacks, and on one the view lacks', () => {
    const added = editView('mes-components', (s) => `${s}\n    mod_ingest --> mod_orders`);
    expect(checkArchitecture(added, FACTS)).toEqual([
      expect.stringMatching(/import edge mod_ingest --> mod_orders is not in the code/),
    ]);
    const facts: Facts = { ...FACTS, moduleImports: [...FACTS.moduleImports, 'quality>genealogy'] };
    expect(checkArchitecture(DOC, facts)).toEqual([
      expect.stringMatching(/import edge mod_quality --> mod_genealogy is missing/),
    ]);
  });

  it('fails on a module folder without a node', () => {
    const facts: Facts = { ...FACTS, modules: [...FACTS.modules, 'maintenance'] };
    expect(checkArchitecture(DOC, facts)).toEqual([
      expect.stringMatching(/\(mes-components\): module mod_maintenance is missing/),
    ]);
  });

  it('fails on a volume missing from the deployment view', () => {
    const doc = editView('deployment', withoutId('vol_pki_ca'));
    expect(checkArchitecture(doc, FACTS)).toEqual([
      expect.stringMatching(/\(deployment\): volume vol_pki_ca is missing/),
    ]);
  });

  it('fails on a prefixed id outside the checked views that names nothing', () => {
    const doc = DOC.replace('participant svc_pki as pki', 'participant svc_certs as pki');
    expect(doc).not.toBe(DOC);
    expect(checkArchitecture(doc, FACTS)).toEqual(
      expect.arrayContaining([expect.stringMatching(/svc_certs names nothing in the code/)]),
    );
  });

  it('fails when a view is unmarked or marked twice, or a marker is unknown', () => {
    const unmarked = DOC.replace('<!-- architecture-check: packages -->', '');
    expect(checkArchitecture(unmarked, FACTS)).toEqual([
      expect.stringMatching(/the view "packages" is marked 0 times/),
    ]);
    const unknown = DOC.replace(
      '<!-- architecture-check: packages -->',
      '<!-- architecture-check: package -->',
    );
    expect(checkArchitecture(unknown, FACTS)).toEqual([
      expect.stringMatching(/unknown view "package"/),
      expect.stringMatching(/the view "packages" is marked 0 times/),
    ]);
  });

  it('fails on a line of a view it cannot read', () => {
    const doc = editView('containers', (s) => `${s}\n    svc_web -- HTTPS --> svc_mes`);
    expect(checkArchitecture(doc, FACTS)).toEqual([expect.stringMatching(/cannot read/)]);
  });
});

describe('the command line', () => {
  it('passes on this repository and fails, naming the drift, on a copy with a fake service', () => {
    const ok = spawnSync(process.execPath, [join(REPO, 'scripts/check-architecture.ts'), REPO], {
      encoding: 'utf8',
    });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^check-architecture: OK \(12 services, 10 volumes, 12 modules/);

    const copy = mkdtempSync(join(tmpdir(), 'check-architecture-repo-'));
    dirs.push(copy);
    const manifests = ['apps', 'packages'].flatMap((group) =>
      readdirSync(join(REPO, group)).map((name) => join(group, name, 'package.json')),
    );
    for (const path of [
      'docker-compose.yml',
      'compose.observability.yml',
      'apps/mes-server/src/modules',
      'e2e/package.json',
      ...manifests,
    ]) {
      if (existsSync(join(REPO, path))) {
        cpSync(join(REPO, path), join(copy, path), { recursive: true });
      }
    }
    mkdirSync(join(copy, 'docs'));
    writeFileSync(
      join(copy, 'docs/architecture.md'),
      editView('containers', (s) => `${s}\n    svc_cache["cache"]`),
    );
    const failed = spawnSync(
      process.execPath,
      [join(REPO, 'scripts/check-architecture.ts'), copy],
      {
        encoding: 'utf8',
      },
    );
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/docs\/architecture\.md and the code disagree/);
    expect(failed.stderr).toMatch(/service svc_cache is not in the code/);
  });
});
