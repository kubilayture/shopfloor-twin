import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { scenarioNames, scenarioOptions } from './golden.ts';
import { loadTimeline, timelineNames, timelinePath } from './timeline.ts';
import {
  lineOeeDocument,
  runHeadless,
  summaryDocument,
  traceDocument,
  type HeadlessOptions,
} from './run.ts';

const DEFAULT_CONFIG = resolve(import.meta.dirname, '../../../../config/plant');
const USAGE =
  'Usage: headless [--seed 0..4294967295] [--days D] [--start ISO-8601 with offset] [--config DIR] [--out DIR]\n' +
  '       headless --scenario NAME [--out DIR]   (a golden scenario of apps/simulator/golden, injections included)\n' +
  '       headless --timeline NAME|FILE [--out DIR]   (a timeline of config/scenarios, or a timeline file)';
const FLUSH_BYTES = 1 << 20;

function usage(problem: string): never {
  console.error(`${problem}\n${USAGE}`);
  process.exit(2);
}

function parse(): {
  seed: number;
  start: number;
  end: number;
  config: string;
  out: string;
  scenario: string | undefined;
  timeline: string | undefined;
  scenarioEnd: number | undefined;
} {
  let values;
  try {
    ({ values } = parseArgs({
      strict: true,
      allowPositionals: false,
      options: {
        seed: { type: 'string' },
        start: { type: 'string' },
        days: { type: 'string' },
        config: { type: 'string' },
        out: { type: 'string', default: 'runs/latest' },
        scenario: { type: 'string' },
        timeline: { type: 'string' },
        end: { type: 'string' },
      },
    }));
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  if (values.scenario !== undefined && values.timeline !== undefined) {
    return usage('--scenario and --timeline exclude each other');
  }
  const named = values.scenario === undefined ? '--timeline' : '--scenario';
  if (values.scenario !== undefined || values.timeline !== undefined) {
    // A scenario or a timeline brings its own seed, span and configuration.
    const extra = (['seed', 'start', 'days', 'config'] as const).filter(
      (name) => values[name] !== undefined,
    );
    if (extra.length > 0) {
      return usage(`${named} takes no ${extra.map((name) => `--${name}`).join(', ')}`);
    }
  }
  let scenarioEnd: number | undefined;
  if (values.end !== undefined) {
    if (values.scenario === undefined && values.timeline === undefined) {
      return usage('--end needs --scenario or --timeline');
    }
    try {
      scenarioEnd = Temporal.Instant.from(values.end).epochMilliseconds;
    } catch {
      return usage(`invalid --end "${values.end}" (needs an offset or Z)`);
    }
  }
  const seedText = values.seed ?? '1';
  const startText = values.start ?? '2026-10-12T06:00:00+03:00';
  const daysText = values.days ?? '7';
  if (!/^\d{1,10}$/.test(seedText) || Number(seedText) >= 2 ** 32) {
    return usage(`invalid --seed "${seedText}"`);
  }
  let start: number;
  try {
    start = Temporal.Instant.from(startText).epochMilliseconds;
  } catch {
    return usage(
      `invalid --start "${startText}" (needs an offset or Z, e.g. 2026-10-12T06:00:00+03:00)`,
    );
  }
  const days = Number(daysText);
  const end = start + Math.round(days * 24 * 3_600_000);
  if (!Number.isFinite(days) || !Number.isSafeInteger(end) || end <= start) {
    return usage(`invalid --days "${daysText}"`);
  }
  if (values.scenario !== undefined && !scenarioNames().includes(values.scenario)) {
    return usage(`no golden scenario "${values.scenario}" (${scenarioNames().join(', ')})`);
  }
  return {
    seed: Number(seedText),
    start,
    end,
    config: values.config ?? DEFAULT_CONFIG,
    out: values.out,
    scenario: values.scenario,
    timeline: values.timeline,
    scenarioEnd,
  };
}

const options = parse();
let run: HeadlessOptions;
if (options.timeline !== undefined) {
  // A timeline (#235): a name of config/scenarios or a file, relative to where pnpm was started.
  const path = timelinePath(options.timeline, process.env.INIT_CWD ?? process.cwd());
  try {
    run = (await loadTimeline(path)).options;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`committed timelines: ${timelineNames().join(', ') || '(none)'}`);
    process.exit(1);
  }
  if (options.scenarioEnd !== undefined) {
    if (options.scenarioEnd <= run.start || options.scenarioEnd > run.end) {
      usage(`--end must be after the timeline's start and not after its end`);
    }
    run = { ...run, end: options.scenarioEnd };
  }
} else if (options.scenario === undefined) {
  const loaded = await loadPlantConfig(resolve(options.config));
  if (!loaded.ok) {
    console.error(formatIssues(loaded.issues));
    process.exit(1);
  }
  run = { config: loaded.config, seed: options.seed, start: options.start, end: options.end };
} else {
  // A golden scenario (#142): its seed, span, configuration and injections, as `test:golden` runs it.
  run = await scenarioOptions(options.scenario);
  if (options.scenarioEnd !== undefined) {
    // An earlier end (#208): the shift-A reference of quality-01. Its event log is a prefix of the
    // full run's after the header (tested); later than the scenario's own end is refused.
    if (options.scenarioEnd <= run.start || options.scenarioEnd > run.end) {
      usage(`--end must be after the scenario's start and not after its end`);
    }
    run = { ...run, end: options.scenarioEnd };
  }
}

const out = resolve(options.out);
mkdirSync(out, { recursive: true });
const eventsPath = join(out, 'events.jsonl');
const summaryPath = join(out, 'summary.json');
const tracePath = join(out, 'trace.json');
const lineOeePath = join(out, 'line-oee.json');
rmSync(eventsPath, { force: true });
rmSync(summaryPath, { force: true });
rmSync(tracePath, { force: true });
rmSync(lineOeePath, { force: true });

const started = performance.now();
const fd = openSync(`${eventsPath}.partial`, 'w');
let chunk = '';
const flush = (): void => {
  writeSync(fd, chunk);
  chunk = '';
};
const result = runHeadless(run, (line) => {
  chunk += `${line}\n`;
  if (chunk.length >= FLUSH_BYTES) {
    flush();
  }
});
flush();
closeSync(fd);
renameSync(`${eventsPath}.partial`, eventsPath);
writeFileSync(`${summaryPath}.partial`, summaryDocument(result));
renameSync(`${summaryPath}.partial`, summaryPath);
writeFileSync(`${tracePath}.partial`, traceDocument(result));
renameSync(`${tracePath}.partial`, tracePath);
writeFileSync(`${lineOeePath}.partial`, lineOeeDocument(result));
renameSync(`${lineOeePath}.partial`, lineOeePath);

const finished = Object.values(result.summary.production.finished).reduce((s, n) => s + n, 0);
const days = (run.end - run.start) / 86_400_000;
console.log(
  `seed ${String(run.seed)}, ${String(days)} days: ${String(result.eventCount)} events, ${String(finished)} parts finished`,
);
console.log(
  `wrote ${eventsPath}, ${summaryPath}, ${tracePath} and ${lineOeePath} in ${(performance.now() - started).toFixed(0)} ms`,
);
