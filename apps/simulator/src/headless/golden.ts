import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { runHeadless, summaryDocument } from './run.ts';

const REPO = resolve(import.meta.dirname, '../../../..');
const GOLDEN = resolve(import.meta.dirname, '../../golden');

interface Scenario {
  readonly seed: number;
  readonly start: string;
  readonly days: number;
  readonly config: string;
}

export interface GoldenOutcome {
  readonly name: string;
  readonly summary: string;
  readonly events: string;
  readonly invariantChecks: number;
}

export async function runScenario(name: string): Promise<GoldenOutcome> {
  const scenario = JSON.parse(
    readFileSync(join(GOLDEN, name, 'scenario.json'), 'utf8'),
  ) as Scenario;
  const loaded = await loadPlantConfig(join(REPO, scenario.config));
  if (!loaded.ok) {
    throw new Error(formatIssues(loaded.issues));
  }
  const start = Temporal.Instant.from(scenario.start).epochMilliseconds;
  const hash = createHash('sha256');
  let lines = 0;
  const result = runHeadless(
    {
      config: loaded.config,
      seed: scenario.seed,
      start,
      end: start + scenario.days * 86_400_000,
      checkInvariants: true,
    },
    (line) => {
      hash.update(`${line}\n`);
      lines++;
    },
  );
  return {
    name,
    summary: summaryDocument(result),
    events: `${hash.digest('hex')}  ${String(lines)} lines\n`,
    invariantChecks: result.invariantChecks,
  };
}

export const scenarioNames = (): string[] =>
  readdirSync(GOLDEN, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

function firstDifference(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const index = a.findIndex((line, i) => line !== b[i]);
  const at = index < 0 ? a.length : index;
  return `line ${String(at + 1)}: expected ${JSON.stringify(a[at] ?? '')}, got ${JSON.stringify(b[at] ?? '')}`;
}

async function main(update: boolean): Promise<number> {
  let failures = 0;
  for (const name of scenarioNames()) {
    const outcome = await runScenario(name);
    const files = { 'summary.json': outcome.summary, 'events.sha256': outcome.events };
    for (const [file, actual] of Object.entries(files)) {
      const path = join(GOLDEN, name, file);
      if (update) {
        writeFileSync(path, actual);
        continue;
      }
      const expected = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (expected !== actual) {
        failures++;
        console.error(
          `✗ ${name}/${file} differs from the committed snapshot — ${firstDifference(expected, actual)}`,
        );
      }
    }
    console.log(
      `${update ? 'updated' : 'checked'} ${name} (${String(outcome.invariantChecks)} invariant checks passed)`,
    );
  }
  if (failures > 0) {
    console.error(
      'Golden snapshots changed. If the change is intended, run `pnpm test:golden --update` and explain why in the pull request (plan section 9).',
    );
  }
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.includes('--update'));
}
