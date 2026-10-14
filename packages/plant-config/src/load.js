import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { crossCheck } from './cross-check.ts';
import { PLANT_FILES } from './schema.ts';
const FILE_NAMES = Object.keys(PLANT_FILES);
async function readYaml(dir, file) {
  const path = join(dir, `${file}.yaml`);
  try {
    return { data: parse(await readFile(path, 'utf8')) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { issue: { file, path: '', message } };
  }
}
export function validatePlantConfig(raw) {
  const issues = [];
  const parsed = {};
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
  const config = parsed;
  const crossIssues = crossCheck(config);
  return crossIssues.length > 0 ? { ok: false, issues: crossIssues } : { ok: true, config };
}
export async function loadPlantConfig(dir) {
  const reads = await Promise.all(FILE_NAMES.map((file) => readYaml(dir, file)));
  const readIssues = reads.flatMap((read) => (read.issue ? [read.issue] : []));
  if (readIssues.length > 0) {
    return { ok: false, issues: readIssues };
  }
  const raw = Object.fromEntries(FILE_NAMES.map((file, i) => [file, reads[i]?.data]));
  return validatePlantConfig(raw);
}
export function formatIssues(issues) {
  return issues
    .map((issue) => `${issue.file}.yaml${issue.path ? ` → ${issue.path}` : ''}: ${issue.message}`)
    .join('\n');
}
