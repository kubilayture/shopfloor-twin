import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { crossCheck, type ConfigIssue } from './cross-check.ts';
import { PLANT_FILES, type PlantConfig } from './schema.ts';

export type LoadResult = { ok: true; config: PlantConfig } | { ok: false; issues: ConfigIssue[] };

type FileName = keyof typeof PLANT_FILES;

const FILE_NAMES = Object.keys(PLANT_FILES) as FileName[];

async function readYaml(
  path: string,
  file: FileName,
): Promise<{ data?: unknown; issue?: ConfigIssue }> {
  try {
    return { data: parse(await readFile(path, 'utf8')) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { issue: { file, path: '', message } };
  }
}

export function validatePlantConfig(raw: Record<FileName, unknown>): LoadResult {
  const issues: ConfigIssue[] = [];
  const parsed: Partial<Record<FileName, unknown>> = {};
  for (const file of FILE_NAMES) {
    const result = PLANT_FILES[file].safeParse(raw[file]);
    if (result.success) {
      parsed[file] = result.data;
    } else {
      issues.push(
        ...result.error.issues.map((issue) => ({
          file,
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      );
    }
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const config = parsed as PlantConfig;
  const crossIssues = crossCheck(config);
  return crossIssues.length > 0 ? { ok: false, issues: crossIssues } : { ok: true, config };
}

export interface LoadOptions {
  /**
   * Another stock file in place of `<dir>/stock.yaml` (Phase 8, ADR-0033): a golden scenario's own
   * `stock` or the live simulator's `SIM_STOCK`. It is validated and cross-checked like the
   * plant's, and it is what the run header's `configSha256` hashes.
   */
  readonly stock?: string | undefined;
}

export async function loadPlantConfig(dir: string, options: LoadOptions = {}): Promise<LoadResult> {
  const pathOf = (file: FileName): string =>
    file === 'stock' && options.stock !== undefined ? options.stock : join(dir, `${file}.yaml`);
  const reads = await Promise.all(FILE_NAMES.map((file) => readYaml(pathOf(file), file)));
  const readIssues = reads.flatMap((read) => (read.issue ? [read.issue] : []));
  if (readIssues.length > 0) {
    return { ok: false, issues: readIssues };
  }
  const raw = Object.fromEntries(FILE_NAMES.map((file, i) => [file, reads[i]?.data])) as Record<
    FileName,
    unknown
  >;
  return validatePlantConfig(raw);
}

export function formatIssues(issues: ConfigIssue[]): string {
  return issues
    .map((issue) => `${issue.file}.yaml${issue.path ? ` → ${issue.path}` : ''}: ${issue.message}`)
    .join('\n');
}
