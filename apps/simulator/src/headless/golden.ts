import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  checkInjections,
  formatIssues,
  loadPlantConfig,
  type InjectionSpec,
} from '@shopfloor/plant-config';
import { PRODUCTION_MODES, type ProductionMode } from '../plant/line.ts';
import {
  lineOeeDocument,
  runHeadless,
  summaryDocument,
  traceDocument,
  type DispatchSpec,
  type HeadlessOptions,
} from './run.ts';

const REPO = resolve(import.meta.dirname, '../../../..');
const GOLDEN = resolve(import.meta.dirname, '../../golden');

export interface Scenario {
  readonly seed: number;
  readonly start: string;
  readonly days: number;
  readonly config: string;
  /**
   * Failure injections (#140) and leak drifts (#196, `kind: 'leak-drift'`, with `until` and
   * `shift`): times are ISO 8601 with an offset or Z.
   */
  readonly injections?: readonly (
    | {
        readonly kind?: undefined;
        readonly at: string;
        readonly machine: string;
        readonly code: string;
        readonly repairMs?: number;
      }
    | {
        readonly kind: 'leak-drift';
        readonly at: string;
        readonly until: string;
        readonly machine: string;
        readonly shift: number;
      }
  )[];
  /**
   * The scenario's own stock file (#196, ADR-0033): a file name in the scenario's folder, read in
   * place of the configuration's `stock.yaml`. Left out, the configuration's stock is used.
   */
  readonly stock?: string;
  /** `schedule` when left out; `orders` (#172) runs only the dispatched jobs. */
  readonly production?: ProductionMode;
  /** Orders mode (#172): `notBefore` is ISO 8601 with an offset or Z. */
  readonly dispatches?: readonly {
    readonly commandId: string;
    readonly machine: string;
    readonly orderId: string;
    readonly product: string;
    readonly quantity: number;
    readonly notBefore: string;
  }[];
  /**
   * Orders mode (#172): the ERP dataset of the scenario (`orders.json` beside it, served by the
   * ERP mock and the golden MES harness) and the orders the scenario releases. Not a simulation
   * input: the simulator runs the `dispatches`, which the MES's dispatch of these released orders
   * must reproduce.
   */
  readonly erp?: { readonly dataset: string; readonly release: readonly string[] };
}

/** A scenario of the golden folder (or of `folder`, a folder of scenario folders, in tests). */
export const readScenario = (name: string, folder = GOLDEN): Scenario =>
  JSON.parse(readFileSync(join(folder, name, 'scenario.json'), 'utf8')) as Scenario;

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

/** The scenario's run options: configuration, seed, span and injections in integer ms. */
export async function scenarioOptions(name: string, folder = GOLDEN): Promise<HeadlessOptions> {
  const scenario = readScenario(name, folder);
  const loaded = await loadPlantConfig(join(REPO, scenario.config), {
    stock: scenarioStock(name, scenario, folder),
  });
  if (!loaded.ok) {
    throw new Error(formatIssues(loaded.issues));
  }
  const start = Temporal.Instant.from(scenario.start).epochMilliseconds;
  const instant = (iso: string): number => Temporal.Instant.from(iso).epochMilliseconds;
  (scenario.injections ?? []).forEach((injection, index) => {
    const kind: unknown = injection.kind;
    if (kind !== undefined && kind !== 'leak-drift') {
      throw new Error(
        `${name}/scenario.json: injections[${String(index)}]: unknown kind ${JSON.stringify(kind)} (a failure injection has no kind; a drift is "leak-drift")`,
      );
    }
  });
  const injections = (scenario.injections ?? []).map((injection): InjectionSpec =>
    injection.kind === 'leak-drift'
      ? {
          kind: injection.kind,
          machine: injection.machine,
          shift: injection.shift,
          at: instant(injection.at),
          until: instant(injection.until),
        }
      : {
          machine: injection.machine,
          code: injection.code,
          at: instant(injection.at),
          ...(injection.repairMs === undefined ? {} : { repairMs: injection.repairMs }),
        },
  );
  const production = scenario.production ?? 'schedule';
  if (!PRODUCTION_MODES.includes(production)) {
    throw new Error(`${name}/scenario.json: unknown production mode "${production}"`);
  }
  const dispatches: DispatchSpec[] = (scenario.dispatches ?? []).map((dispatch) => ({
    commandId: dispatch.commandId,
    machine: dispatch.machine,
    orderId: dispatch.orderId,
    product: dispatch.product,
    quantity: dispatch.quantity,
    notBefore: Temporal.Instant.from(dispatch.notBefore).epochMilliseconds,
  }));
  const end = start + scenario.days * 86_400_000;
  const issues = checkInjections(loaded.config, injections, end);
  if (issues.length > 0) {
    throw new Error(
      `${name}/scenario.json: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
  }
  return {
    config: loaded.config,
    seed: scenario.seed,
    start,
    end,
    ...(injections.length === 0 ? {} : { injections }),
    ...(production === 'schedule' ? {} : { production }),
    ...(dispatches.length === 0 ? {} : { dispatches }),
  };
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
