import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { runHeadless, summaryDocument } from './run.ts';

const DEFAULT_CONFIG = resolve(import.meta.dirname, '../../../../config/plant');

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '1' },
    start: { type: 'string', default: '2026-10-12T06:00:00+03:00' },
    days: { type: 'string', default: '7' },
    config: { type: 'string', default: DEFAULT_CONFIG },
    out: { type: 'string', default: 'runs/latest' },
  },
});

const seed = Number(values.seed);
const days = Number(values.days);
const start = Date.parse(values.start);
if (!Number.isInteger(seed) || seed < 0 || !(days > 0) || Number.isNaN(start)) {
  console.error(
    'Usage: headless [--seed N] [--days D] [--start ISO-8601] [--config DIR] [--out DIR]',
  );
  process.exit(2);
}

const loaded = await loadPlantConfig(resolve(values.config));
if (!loaded.ok) {
  console.error(formatIssues(loaded.issues));
  process.exit(1);
}

const out = resolve(values.out);
await mkdir(out, { recursive: true });
const eventsPath = join(out, 'events.jsonl');
const stream = createWriteStream(eventsPath);
const started = performance.now();
const result = runHeadless(
  { config: loaded.config, seed, start, end: start + Math.round(days * 24 * 3_600_000) },
  (line) => stream.write(`${line}\n`),
);
await new Promise<void>((done, fail) => {
  stream.end(() => {
    done();
  });
  stream.on('error', fail);
});
const summaryPath = join(out, 'summary.json');
await writeFile(summaryPath, summaryDocument(result));

const finished = Object.values(result.summary.production.finished).reduce((s, n) => s + n, 0);
console.log(
  `seed ${String(seed)}, ${String(days)} days: ${String(result.eventCount)} events, ${String(finished)} parts finished, ${String(result.summary.production.started - finished)} not finished or scrapped`,
);
console.log(
  `wrote ${eventsPath} and ${summaryPath} in ${(performance.now() - started).toFixed(0)} ms`,
);
