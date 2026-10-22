import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPENAPI_FILE, generateOpenApi } from './openapi.ts';
import {
  PRODUCT_VERSION,
  ROOT_PACKAGE_FILE,
  SEMANTIC_VERSION,
  readProductVersion,
} from './version.ts';

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
    expect(PRODUCT_VERSION).toMatch(SEMANTIC_VERSION);
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

  it('refuses a package.json without a semantic version, naming the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mes-version-'));
    try {
      const file = join(dir, 'package.json');
      for (const content of ['{"name":"x"}', '{"version":"1.0"}', '{"version":1}', '[]']) {
        await writeFile(file, content);
        expect(() => readProductVersion(file)).toThrow(`${file}: no semantic "version"`);
      }
      await writeFile(file, '{"version": ');
      expect(() => readProductVersion(file)).toThrow(`${file}: cannot read the product version`);
      expect(() => readProductVersion(join(dir, 'missing.json'))).toThrow(
        /missing\.json: cannot read the product version/,
      );
      for (const good of ['1.0.1', '2.0.0-rc.1']) {
        await writeFile(file, JSON.stringify({ version: good }));
        expect(readProductVersion(file)).toBe(good);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the committed OpenAPI describes the deployed session cookie (MES_COOKIE_SECURE=on)', () => {
  it('names __Host-sft_session with Secure on the login', async () => {
    const document = JSON.parse(await readFile(OPENAPI_FILE, 'utf8')) as {
      info: { description: string };
      paths: Record<string, Record<string, { description?: string }>>;
    };
    const login = document.paths['/api/v1/session']?.post?.description ?? '';
    expect(login).toContain(
      'Sets `__Host-sft_session` (Path=/, HttpOnly, SameSite=Strict, Secure)',
    );
    expect(login).toContain('`sft_session`, without Secure, only with MES_COOKIE_SECURE=off');
    expect(document.info.description).toContain('__Host-sft_session');
  });
});
