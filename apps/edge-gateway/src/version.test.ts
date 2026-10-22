import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_VERSION,
  ROOT_PACKAGE_FILE,
  SEMANTIC_VERSION,
  readProductVersion,
} from './version.ts';

// No broker here: `gateway.test.ts` checks that the published `_sys` status carries it.
describe('the product version (P10-09)', () => {
  it('is the root package.json version', async () => {
    const root = resolve(import.meta.dirname, '../../../package.json');
    expect(ROOT_PACKAGE_FILE).toBe(root);
    const parsed = JSON.parse(await readFile(root, 'utf8')) as { version?: unknown };
    expect(PRODUCT_VERSION).toBe(parsed.version);
    expect(PRODUCT_VERSION).toMatch(SEMANTIC_VERSION);
  });

  it('refuses a package.json without a semantic version, naming the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gateway-version-'));
    try {
      const file = join(dir, 'package.json');
      for (const content of ['{"name":"x"}', '{"version":"1.0"}', '{"version":1}', 'null']) {
        await writeFile(file, content);
        expect(() => readProductVersion(file)).toThrow(`${file}: no semantic "version"`);
      }
      await writeFile(file, 'not json');
      expect(() => readProductVersion(file)).toThrow(`${file}: cannot read the product version`);
      for (const good of ['1.0.1', '2.0.0-rc.1']) {
        await writeFile(file, JSON.stringify({ version: good }));
        expect(readProductVersion(file)).toBe(good);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
