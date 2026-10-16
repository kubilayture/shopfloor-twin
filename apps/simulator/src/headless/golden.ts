import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkInjections, formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { runHeadless, summaryDocument, type HeadlessOptions } from './run.ts';

const REPO = resolve(import.meta.dirname, '../../../..');
const GOLDEN = resolve(import.meta.dirname, '../../golden');

export interface Scenario {
  readonly seed: number;
  readonly start: string;
  readonly days: number;
  readonly config: string;
  /** Failure injections (#140): `at` is ISO 8601 with an offset or Z. */
  readonly injections?: readonly {
    readonly at: string;
    readonly machine: string;
    readonly code: string;
    readonly repairMs?: number;
  }[];
}

export const readScenario = (name: string): Scenario =>
  JSON.parse(readFileSync(join(GOLDEN, name, 'scenario.json'), 'utf8')) as Scenario;

/** The scenario's run options: configuration, seed, span and injections in integer ms. */
export async function scenarioOptions(name: string): Promise<HeadlessOptions> {
  const scenario = readScenario(name);
  const loaded = await loadPlantConfig(join(REPO, scenario.config));
  if (!loaded.ok) {
    throw new Error(formatIssues(loaded.issues));
  }
  const start = Temporal.Instant.from(scenario.start).epochMilliseconds;
  const injections = (scenario.injections ?? []).map((injection) => ({
    machine: injection.machine,
    code: injection.code,
    at: Temporal.Instant.from(injection.at).epochMilliseconds,
    ...(injection.repairMs === undefined ? {} : { repairMs: injection.repairMs }),
  }));
  const issues = checkInjections(loaded.config, injections);
  if (issues.length > 0) {
    throw new Error(
      `${name}/scenario.json: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
  }
  return {
    config: loaded.config,
    seed: scenario.seed,
    start,
    end: start + scenario.days * 86_400_000,
    ...(injections.length === 0 ? {} : { injections }),
  };
}

export interface GoldenOutcome {
  readonly name: string;
  readonly summary: string;
  readonly events: string;
  readonly invariantChecks: number;
}

export async function runScenario(name: string): Promise<GoldenOutcome> {
  const options = await scenarioOptions(name);
  const hash = createHash('sha256');
  let lines = 0;
  const result = runHeadless({ ...options, checkInvariants: true }, (line) => {
    hash.update(`${line}\n`);
    lines++;
  });
  return {
    name,
    summary: summaryDocument(result),
    events: `${hash.digest('hex')}  ${String(lines)} lines\n`,
    invariantChecks: result.invariantChecks,
  };
}

export const scenarioNames = (): string[] =>
  readdirSync(GOLDEN, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(GOLDEN, entry.name, 'scenario.json')))
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
      if (!existsSync(path)) {
        failures++;
        console.error(
          `✗ ${name}/${file} is missing — run \`pnpm test:golden --update\` to create it`,
        );
        continue;
      }
      const expected = readFileSync(path, 'utf8');
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
