/**
 * Scenario timelines (#235, ADR-0037): `config/scenarios/<name>.yaml`, parsed by `plant-config`'s
 * scenario schema and mapped onto `HeadlessOptions` exactly as a golden `scenario.json` is.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  checkScenarioPlan,
  formatIssues,
  loadPlantConfig,
  readScenarioFile,
  scenarioPlan,
  type PlantConfig,
  type Scenario,
  type ScenarioPlan,
} from '@shopfloor/plant-config';
import { configHash, type HeadlessOptions } from './run.ts';

export const REPO = resolve(import.meta.dirname, '../../../..');
/** The committed timelines. */
export const SCENARIOS = join(REPO, 'config/scenarios');

/** A timeline name of the committed folder: kebab-case, no path. */
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The path of a timeline: a bare name is `<folder>/<name>.yaml`; anything else is a path,
 * relative to `cwd`.
 */
export function timelinePath(value: string, cwd: string, folder = SCENARIOS): string {
  return NAME.test(value) ? join(folder, `${value}.yaml`) : resolve(cwd, value);
}

/** The committed timelines' names, sorted. */
export function timelineNames(folder = SCENARIOS): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((file) => file.endsWith('.yaml') && NAME.test(file.slice(0, -'.yaml'.length)))
    .map((file) => file.slice(0, -'.yaml'.length))
    .sort();
}

/**
 * A plan's run options, refused with every issue (`label: path: message; …`) when the plan does
 * not fit the configuration. The lists keep the golden mapping: dispatches, injections and actions
 * each in list order, each key only when it has entries; infrastructure entries are not
 * simulation inputs and are left out.
 */
export function planOptions(
  config: PlantConfig,
  plan: ScenarioPlan,
  label: string,
): HeadlessOptions {
  const issues = checkScenarioPlan(config, plan);
  // A recording (#236 review) names the configuration it was made with; another one can't replay it.
  if (plan.configSha256 !== undefined && plan.configSha256 !== configHash(config)) {
    issues.push({
      path: 'configSha256',
      message: `the recording was made with configuration ${plan.configSha256}, this configuration is ${configHash(config)}`,
    });
  }
  if (issues.length > 0) {
    throw new Error(`${label}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  }
  return {
    config,
    seed: plan.seed,
    start: plan.start,
    end: plan.end,
    ...(plan.injections.length === 0 ? {} : { injections: plan.injections }),
    ...(plan.production === 'schedule' ? {} : { production: plan.production }),
    ...(plan.dispatches.length === 0 ? {} : { dispatches: plan.dispatches }),
    ...(plan.actions.length === 0 ? {} : { actions: plan.actions }),
    ...(plan.inputOrder === undefined ? {} : { inputOrder: plan.inputOrder }),
    ...(plan.endAfterEvents === undefined ? {} : { endAfterEvents: plan.endAfterEvents }),
  };
}

export interface LoadedTimeline {
  readonly path: string;
  readonly scenario: Scenario;
  readonly plan: ScenarioPlan;
  readonly options: HeadlessOptions;
}

/**
 * Reads a timeline (or a `scenario.json`) and its configuration (`config`, relative to the
 * repository root, with the scenario's own stock file if it names one) into headless options.
 */
export async function loadTimeline(path: string): Promise<LoadedTimeline> {
  const read = await readScenarioFile(path);
  if (!read.ok) throw new Error(`${path}: ${read.message}`);
  const loaded = await loadPlantConfig(join(REPO, read.scenario.config), { stock: read.stock });
  if (!loaded.ok) throw new Error(formatIssues(loaded.issues));
  const plan = scenarioPlan(read.scenario);
  return { path, scenario: read.scenario, plan, options: planOptions(loaded.config, plan, path) };
}
