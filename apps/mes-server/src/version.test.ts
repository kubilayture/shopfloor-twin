import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPENAPI_FILE, generateOpenApi } from './openapi.ts';
import { PRODUCT_VERSION, ROOT_PACKAGE_FILE, readProductVersion } from './version.ts';

const rootVersion = async (): Promise<unknown> =>
  (
    JSON.parse(await readFile(resolve(import.meta.dirname, '../../../package.json'), 'utf8')) as {
      version?: unknown;
    }
  ).version;

describe('the product version (P10-09)', () => {
  it('is the root package.json version', async () => {
    expect(ROOT_PACKAGE_FILE).toBe(resolve(import.meta.dirname, '../../../package.json'));
    expect(PRODUCT_VERSION).toBe(await rootVersion());
    expect(PRODUCT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is what the MES reports: the OpenAPI info.version, generated and committed', async () => {
    const version = await rootVersion();
    const generated = JSON.parse(await generateOpenApi()) as { info: { version: string } };
    expect(generated.info.version).toBe(version);
    const committed = JSON.parse(await readFile(OPENAPI_FILE, 'utf8')) as {
      info: { version: string };
    };
    expect(committed.info.version).toBe(version);
  });

  it('refuses a package.json without a semantic version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mes-version-'));
    try {
      const file = join(dir, 'package.json');
      for (const content of ['{"name":"x"}', '{"version":"1.0"}', '{"version":1}', '[]']) {
        await writeFile(file, content);
        expect(() => readProductVersion(file)).toThrow(/no semantic "version"/);
      }
      await writeFile(file, '{"version":"1.0.1"}');
      expect(readProductVersion(file)).toBe('1.0.1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
