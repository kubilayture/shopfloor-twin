import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  formatIssues,
  loadPlantConfig,
  parseScenario,
  scenarioPlan,
  type Scenario,
} from '@shopfloor/plant-config';
import {
  lineOeeDocument,
  runHeadless,
  summaryDocument,
  traceDocument,
  type HeadlessOptions,
} from './run.ts';
import { REPO, planOptions } from './timeline.ts';

const GOLDEN = resolve(import.meta.dirname, '../../golden');

/**
 * A golden `scenario.json` (#142): seed, start, span, configuration, and the `injections`
 * (failures and drifts), `dispatches` and `actions` of the run. Parsed by `plant-config`'s scenario
 * schema (#235), the one a timeline of `config/scenarios/` is parsed by.
 */
export type { Scenario };

/** A scenario of the golden folder (or of `folder`, a folder of scenario folders, in tests). */
export function readScenario(name: string, folder = GOLDEN): Scenario {
  const raw: unknown = JSON.parse(readFileSync(join(folder, name, 'scenario.json'), 'utf8'));
  const parsed = parseScenario(raw);
  if (!parsed.ok) {
    throw new Error(
      `${name}/scenario.json: ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.scenario;
}

/** The path of a scenario's own stock file, if it names one (#196); only a file of its folder. */
export function scenarioStock(
  name: string,
  scenario: Scenario = readScenario(name),
  folder = GOLDEN,
): string | undefined {
  if (scenario.stock === undefined) return undefined;
  if (basename(scenario.stock) !== scenario.stock || scenario.stock.startsWith('.')) {
    throw new Error(`${name}/scenario.json: stock must be a file name in the scenario's folder`);
  }
  return join(folder, name, scenario.stock);
}

/**
 * The scenario's run options: configuration, seed, span, and its dispatches, injections and
 * actions in integer ms, as `scenarioPlan` maps them (#235: the mapping of #172, #196 and #234
 * unchanged).
 */
export async function scenarioOptions(name: string, folder = GOLDEN): Promise<HeadlessOptions> {
  const scenario = readScenario(name, folder);
  const loaded = await loadPlantConfig(join(REPO, scenario.config), {
    stock: scenarioStock(name, scenario, folder),
  });
  if (!loaded.ok) {
    throw new Error(formatIssues(loaded.issues));
  }
  return planOptions(loaded.config, scenarioPlan(scenario), `${name}/scenario.json`);
}

export interface GoldenOutcome {
  readonly name: string;
  readonly summary: string;
  /** `trace.json` (#208): the traceability and SPC truth beside the summary. */
  readonly trace: string;
  /** `line-oee.json` (#230): the order and line OEE truth beside the summary. */
  readonly lineOee: string;
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
    trace: traceDocument(result),
    lineOee: lineOeeDocument(result),
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
    const files = {
      'summary.json': outcome.summary,
      'trace.json': outcome.trace,
      'line-oee.json': outcome.lineOee,
      'events.sha256': outcome.events,
    };
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
