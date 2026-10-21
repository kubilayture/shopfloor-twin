import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ERP_PROBLEM_TYPES } from '@shopfloor/contracts/erp-api';
import { describe, expect, it } from 'vitest';
import { loadDataset } from './dataset.ts';
import { envSchema } from './env.ts';
import { Erp } from './erp.ts';
import { createLogger } from './log.ts';
import { createErpServer } from './server.ts';
import { ErpStore } from './store.ts';

// docs/api/erp-mock.md is the API's reference (P10-04, #279): its route table must equal the
// server's own route table (`apiRoutes`), so a route added, removed or given another method
// without a change of the document fails here.

const REPO = resolve(import.meta.dirname, '../../..');
const DOC = join(REPO, 'docs/api/erp-mock.md');

/** The rows of the first table under `## <heading>`, as trimmed cells. */
function tableUnder(markdown: string, heading: string): string[][] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`no section "## ${heading}"`);
  const rows: string[][] = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (line.trimStart().startsWith('|')) {
      inTable = true;
      rows.push(
        line
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim()),
      );
    } else if (inTable) break;
  }
  // Header and the separator row.
  return rows.slice(2);
}

/** `GET` and `` `/api/v1/orders/{orderNumber}` `` as the server declares it: `GET ^/api/v1/orders/([^/]+)$`. */
function documentedRoute(method: string, pathCell: string): string {
  const path = /^`([^`]+)`$/.exec(pathCell)?.[1];
  if (path === undefined) throw new Error(`path cell ${pathCell} is not one code span`);
  if (!path.startsWith('/api/v1/')) throw new Error(`${path} is not an /api/v1 route`);
  return `${method} ^${path.replaceAll(/\{[^}/]+\}/g, '([^/]+)')}$`;
}

describe('docs/api/erp-mock.md against the code', () => {
  const doc = readFileSync(DOC, 'utf8');

  it('documents exactly the routes and methods of the server (apiRoutes)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'erp-api-doc-'));
    const store = new ErpStore(join(dir, 'erp.db'));
    try {
      const dataset = await loadDataset(
        join(REPO, 'config/erp/orders.yaml'),
        join(REPO, 'config/plant'),
      );
      const server = createErpServer({
        erp: new Erp(dataset, store),
        store,
        token: 'doc-test-token-0123456789',
        admin: false,
        log: createLogger('silent'),
      });
      const declared = server.apiRoutes.flatMap((route) =>
        route.methods.map((method) => `${method} ${route.pattern.source.replaceAll('\\/', '/')}`),
      );
      const documented = tableUnder(doc, 'Routes').map(([method = '', path = '']) =>
        documentedRoute(method, path),
      );
      expect(new Set(documented).size, 'a route documented twice').toBe(documented.length);
      expect(documented.sort()).toEqual(declared.sort());
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names every problem type and every environment variable', () => {
    const errors = tableUnder(doc, 'Errors').map(([, type = '']) => type.replaceAll('`', ''));
    expect(errors.sort()).toEqual(Object.values(ERP_PROBLEM_TYPES).sort());
    const variables = tableUnder(doc, 'Environment').map(([name = '']) => name.replaceAll('`', ''));
    expect(variables.sort()).toEqual(Object.keys(envSchema.shape).sort());
  });

  it('reads a route row the way the server writes a pattern', () => {
    expect(documentedRoute('GET', '`/api/v1/orders/{orderNumber}`')).toBe(
      'GET ^/api/v1/orders/([^/]+)$',
    );
    expect(() => documentedRoute('GET', '`/health/live`')).toThrow(/not an \/api\/v1 route/);
    expect(() => documentedRoute('GET', '/api/v1/lots')).toThrow(/one code span/);
    expect(() => tableUnder('# x', 'Routes')).toThrow(/no section/);
  });
});
