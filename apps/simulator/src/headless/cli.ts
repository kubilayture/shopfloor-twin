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
import { runHeadless, summaryDocument, type HeadlessOptions } from './run.ts';

const DEFAULT_CONFIG = resolve(import.meta.dirname, '../../../../config/plant');
const USAGE =
  'Usage: headless [--seed 0..4294967295] [--days D] [--start ISO-8601 with offset] [--config DIR] [--out DIR]\n' +
  '       headless --scenario NAME [--out DIR]   (a golden scenario of apps/simulator/golden, injections included)';
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
      },
    }));
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  if (values.scenario !== undefined) {
    // A scenario brings its own seed, span and configuration.
    const extra = (['seed', 'start', 'days', 'config'] as const).filter(
      (name) => values[name] !== undefined,
    );
    if (extra.length > 0) {
      return usage(`--scenario takes no ${extra.map((name) => `--${name}`).join(', ')}`);
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
  };
}

const options = parse();
let run: HeadlessOptions;
if (options.scenario === undefined) {
  const loaded = await loadPlantConfig(resolve(options.config));
  if (!loaded.ok) {
    console.error(formatIssues(loaded.issues));
    process.exit(1);
  }
  run = { config: loaded.config, seed: options.seed, start: options.start, end: options.end };
} else {
  // A golden scenario (#142): its seed, span, configuration and injections, as `test:golden` runs it.
  run = await scenarioOptions(options.scenario);
}

const out = resolve(options.out);
mkdirSync(out, { recursive: true });
const eventsPath = join(out, 'events.jsonl');
const summaryPath = join(out, 'summary.json');
rmSync(eventsPath, { force: true });
rmSync(summaryPath, { force: true });

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

const finished = Object.values(result.summary.production.finished).reduce((s, n) => s + n, 0);
const days = (run.end - run.start) / 86_400_000;
console.log(
  `seed ${String(run.seed)}, ${String(days)} days: ${String(result.eventCount)} events, ${String(finished)} parts finished`,
);
console.log(
  `wrote ${eventsPath} and ${summaryPath} in ${(performance.now() - started).toFixed(0)} ms`,
);
