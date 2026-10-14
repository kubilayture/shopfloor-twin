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
import { runHeadless, summaryDocument } from './run.ts';

const DEFAULT_CONFIG = resolve(import.meta.dirname, '../../../../config/plant');
const USAGE =
  'Usage: headless [--seed 0..4294967295] [--days D] [--start ISO-8601 with offset] [--config DIR] [--out DIR]';
const FLUSH_BYTES = 1 << 20;

function usage(problem: string): never {
  console.error(`${problem}\n${USAGE}`);
  process.exit(2);
}

function parse(): { seed: number; start: number; end: number; config: string; out: string } {
  let values;
  try {
    ({ values } = parseArgs({
      strict: true,
      allowPositionals: false,
      options: {
        seed: { type: 'string', default: '1' },
        start: { type: 'string', default: '2026-10-12T06:00:00+03:00' },
        days: { type: 'string', default: '7' },
        config: { type: 'string', default: DEFAULT_CONFIG },
        out: { type: 'string', default: 'runs/latest' },
      },
    }));
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  if (!/^\d{1,10}$/.test(values.seed) || Number(values.seed) >= 2 ** 32) {
    return usage(`invalid --seed "${values.seed}"`);
  }
  let start: number;
  try {
    start = Temporal.Instant.from(values.start).epochMilliseconds;
  } catch {
    return usage(
      `invalid --start "${values.start}" (needs an offset or Z, e.g. 2026-10-12T06:00:00+03:00)`,
    );
  }
  const days = Number(values.days);
  const end = start + Math.round(days * 24 * 3_600_000);
  if (!Number.isFinite(days) || !Number.isSafeInteger(end) || end <= start) {
    return usage(`invalid --days "${values.days}"`);
  }
  return { seed: Number(values.seed), start, end, config: values.config, out: values.out };
}

const options = parse();
const loaded = await loadPlantConfig(resolve(options.config));
if (!loaded.ok) {
  console.error(formatIssues(loaded.issues));
  process.exit(1);
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
const result = runHeadless(
  { config: loaded.config, seed: options.seed, start: options.start, end: options.end },
  (line) => {
    chunk += `${line}\n`;
    if (chunk.length >= FLUSH_BYTES) {
      flush();
    }
  },
);
flush();
closeSync(fd);
renameSync(`${eventsPath}.partial`, eventsPath);
writeFileSync(`${summaryPath}.partial`, summaryDocument(result));
renameSync(`${summaryPath}.partial`, summaryPath);

const finished = Object.values(result.summary.production.finished).reduce((s, n) => s + n, 0);
const days = (options.end - options.start) / 86_400_000;
console.log(
  `seed ${String(options.seed)}, ${String(days)} days: ${String(result.eventCount)} events, ${String(finished)} parts finished`,
);
console.log(
  `wrote ${eventsPath} and ${summaryPath} in ${(performance.now() - started).toFixed(0)} ms`,
);
