import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The repository's root `package.json`; the image copies it to `/app/package.json`. */
export const ROOT_PACKAGE_FILE = resolve(import.meta.dirname, '../../../package.json');

/** A semantic version, with an optional pre-release part. */
export const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The product version (Phase 10 plan, "Release mechanics"): the root `package.json`'s `version`,
 * the one source for the tag, the CHANGELOG and the version the gateway reports (`version` in its
 * `_sys` status). The MES reads the same file (`apps/mes-server/src/version.ts`). Workspace
 * `package.json` files stay `0.0.0` and are not read.
 */
export function readProductVersion(file = ROOT_PACKAGE_FILE): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`${file}: cannot read the product version`, { cause });
  }
  const version =
    typeof parsed === 'object' && parsed !== null && 'version' in parsed
      ? parsed.version
      : undefined;
  if (typeof version !== 'string' || !SEMANTIC_VERSION.test(version)) {
    throw new Error(`${file}: no semantic "version"`);
  }
  return version;
}

export const PRODUCT_VERSION = readProductVersion();
