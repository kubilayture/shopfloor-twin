import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatIssues, loadPlantConfig, validatePlantConfig } from './load.ts';
import { PLANT_FILES, type PlantConfig } from './schema.ts';
import { MACHINE_SCRAP_REASONS, scrapRoot } from './scrap.ts';

const DEFAULT_DIR = resolve(import.meta.dirname, '../../../config/plant');

let defaults: Record<string, unknown>;

beforeAll(async () => {
  defaults = Object.fromEntries(
    await Promise.all(
      Object.keys(PLANT_FILES).map(async (file): Promise<[string, unknown]> => [
        file,
        parse(await readFile(join(DEFAULT_DIR, `${file}.yaml`), 'utf8')) as unknown,
      ]),
    ),
  );
});

const messagesFor = (change: (config: PlantConfig) => void): string => {
  const copy = structuredClone(defaults) as PlantConfig;
  change(copy);
  const result = validatePlantConfig(copy);
  return result.ok
    ? ''
    : result.issues.map((issue) => `${issue.file}:${issue.path}: ${issue.message}`).join('\n');
};

describe('scrap reason codes (#175)', () => {
  it('loads the default tree with every machine scrap reason as a top node', async () => {
    const loaded = await loadPlantConfig(DEFAULT_DIR);
    if (!loaded.ok) throw new Error(formatIssues(loaded.issues));
    const ids = loaded.config.scrap.reasons.map((r) => r.id);
    for (const machine of MACHINE_SCRAP_REASONS) expect(ids).toContain(machine);
    expect(ids.filter((id) => !id.includes('/')).sort()).toEqual([...MACHINE_SCRAP_REASONS]);
    expect(scrapRoot('LEAK/POROSITY')).toBe('LEAK');
    expect(scrapRoot('LEAK')).toBe('LEAK');
  });

  it('refuses duplicates, children before parents and a missing machine reason', () => {
    expect(
      messagesFor((c) => {
        c.scrap.reasons.push({ id: 'LEAK', name: 'again' });
      }),
    ).toContain('scrap:reasons[11]: duplicate reason "LEAK"');
    expect(
      messagesFor((c) => {
        c.scrap.reasons.unshift({ id: 'LATE/CHILD', name: 'x' });
      }),
    ).toContain('scrap:reasons[0]: parent "LATE" must be listed before "LATE/CHILD"');
    expect(
      messagesFor((c) => {
        c.scrap.reasons = c.scrap.reasons.filter((r) => !r.id.startsWith('DIMENSIONAL'));
      }),
    ).toContain('scrap:reasons: the machine scrap reason "DIMENSIONAL" must be a node of the tree');
    expect(
      messagesFor((c) => {
        c.scrap.reasons.push({ id: 'lower', name: 'x' });
      }),
    ).toContain('scrap:reasons.11.id');
  });
});
